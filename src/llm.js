// The ONLY file in Crucible that knows which vendor we are talking to.
// Stage 1 runs on a free tier; Stage 2 swaps LLM_PROVIDER and adds an adapter here.
//
// RESEARCHED CONSTRAINT (Aug 2026): free tiers are RPM-capped at the org level.
//   Groq            ~30 RPM / 1K RPD   <- default, 3x the headroom
//   Gemini Flash    ~10 RPM / 250 RPD
//   Gemini Lite     ~15 RPM / 1K RPD
// One run = turns*2 + 1 calls per adversary. At 4 turns x 2 adversaries = 18 calls.
// The pacer below keeps us under the cap deliberately instead of 429-storming on camera.

const PROVIDER = process.env.LLM_PROVIDER || 'openai';
const RPM = Number(process.env.LLM_RPM || (PROVIDER === 'openai' ? 28 : 9)); // a little under the cap

const ADAPTERS = {
  gemini: {
    keyName: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
    listUrl: () => 'https://generativelanguage.googleapis.com/v1beta/models',
    listHeaders: () => ({ 'x-goog-api-key': process.env.GEMINI_API_KEY }),
    listExtract: (d) => (d.models || []).map((m) => m.name.replace('models/', '')),
    build(messages, system, model, maxTokens, temperature) {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
        body: {
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        },
      };
    },
    extract(data) {
      const parts = data?.candidates?.[0]?.content?.parts;
      if (!parts) {
        const why = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'no content';
        throw new Error(`empty response (${why})`);
      }
      return parts.map((p) => p.text || '').join('').trim();
    },
  },

  // Sarvam - India's Indic-language stack. Used for the code-switching attacks:
  // an English-first model writes unconvincing Hinglish, and an unconvincing
  // attacker is a useless test. Verified shape (docs.sarvam.ai, Aug 2026):
  // POST /v1/chat/completions, api-subscription-key header, OpenAI-shaped reply.
  sarvam: {
    keyName: 'SARVAM_API_KEY',
    defaultModel: 'sarvam-30b',
    listUrl: () => 'https://api.sarvam.ai/v1/models',
    listHeaders: () => ({ 'api-subscription-key': process.env.SARVAM_API_KEY }),
    listExtract: (d) => (d.data || []).map((m) => m.id),
    build(messages, system, model, maxTokens, temperature) {
      return {
        url: 'https://api.sarvam.ai/v1/chat/completions',
        headers: {
          'api-subscription-key': process.env.SARVAM_API_KEY,
          'content-type': 'application/json',
        },
        body: {
          model,
          max_tokens: maxTokens,
          temperature,
          messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
        },
      };
    },
    extract(data) {
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('empty response');
      return text.trim();
    },
  },

  openai: {
    keyName: 'LLM_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    base: () => process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1',
    listUrl() { return `${this.base()}/models`; },
    listHeaders: () => ({ authorization: `Bearer ${process.env.LLM_API_KEY}` }),
    listExtract: (d) => (d.data || []).map((m) => m.id),
    build(messages, system, model, maxTokens, temperature) {
      return {
        url: `${this.base()}/chat/completions`,
        headers: { authorization: `Bearer ${process.env.LLM_API_KEY}`, 'content-type': 'application/json' },
        body: {
          model,
          max_tokens: maxTokens,
          temperature,
          messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
        },
      };
    },
    extract(data) {
      const choice = data?.choices?.[0];
      const text = choice?.message?.content;
      if (!text) {
        const why = choice?.finish_reason || 'no content';
        const hint = why === 'length'
          ? 'reasoning consumed the whole budget - raise maxTokens'
          : 'model returned no content';
        throw Object.assign(new Error(`empty response (finish_reason=${why}) - ${hint}`), { fatal: true });
      }
      return text.trim();
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Providers tell us the real limits on every response. Record them.
export const limits = {};
function captureLimits(res) {
  for (const [k, v] of res.headers) {
    if (k.startsWith('x-ratelimit')) limits[k.replace('x-ratelimit-', '')] = v;
  }
}

function adapter(name = PROVIDER) {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`Unknown provider "${name}". Use: ${Object.keys(ADAPTERS).join(', ')}`);
  if (!process.env[a.keyName]) {
    throw new Error(`${a.keyName} is not set. Copy .env.example to .env and add Crucible's own key.`);
  }
  return a;
}

/** Is a provider usable right now? Lets us fall back instead of crashing a run. */
export function providerReady(name) {
  const a = ADAPTERS[name];
  return Boolean(a && process.env[a.keyName]);
}

// ── Pacer ────────────────────────────────────────────────────────────────────
// MEASURED (Groq gpt-oss-120b, Aug 2026): the binding limit is TOKENS per minute
// (8,000), not requests (30). A 9-call run burned ~4,750 tokens. So we pace on
// RPM as a floor AND back off on the provider's own remaining-tokens header.
// Guessing a fixed rate is what puts a 429 on camera.
const minGapMs = Math.ceil(60000 / RPM);
let nextSlot = 0;
let tokenHoldUntil = 0;

const parseReset = (v) => {
  if (!v) return 0;
  const m = String(v).match(/(?:([0-9.]+)m)?([0-9.]+)s/);
  if (!m) return Number(v) * 1000 || 0;
  return (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 1000;
};

function noteTokenBudget() {
  const remaining = Number(limits['remaining-tokens']);
  if (!Number.isFinite(remaining)) return;
  // Below roughly two calls' worth, wait out the window rather than 429.
  if (remaining < 1800) {
    const waitMs = parseReset(limits['reset-tokens']) + 500;
    tokenHoldUntil = Math.max(tokenHoldUntil, Date.now() + Math.min(waitMs, 65000));
  }
}

async function takeSlot() {
  if (tokenHoldUntil > Date.now()) {
    await sleep(tokenHoldUntil - Date.now());
    tokenHoldUntil = 0;
  }
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + minGapMs;
  if (slot > now) await sleep(slot - now);
}

export async function chat(messages, { system, maxTokens = 700, temperature = 0.9, model, provider } = {}) {
  // A caller may route one call to a different provider - e.g. Indic attacks to
  // Sarvam - and we silently fall back if that provider has no key configured.
  const name = provider && providerReady(provider) ? provider : PROVIDER;
  const a = adapter(name);
  const useModel = model || (provider === name ? a.defaultModel : process.env.LLM_MODEL) || a.defaultModel;
  let lastErr;

  for (let attempt = 0; attempt < 5; attempt++) {
    await takeSlot();
    const { url, headers, body } = a.build(messages, system, useModel, maxTokens, temperature);
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      captureLimits(res);
      noteTokenBudget();
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        await sleep(retryAfter || 1500 * 2 ** attempt);
        continue;
      }
      // 4xx other than 429 is our mistake - bad model, bad key, bad body. Do not burn retries.
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`), { fatal: true });
      }
      return a.extract(await res.json());
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === 4) break;
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw new Error(`LLM call failed after 5 attempts: ${lastErr?.message}`);
}

/** Ask the API what this key can actually see - never guess a model name again. */
export async function listModels() {
  const a = adapter();
  const res = await fetch(a.listUrl(), { headers: a.listHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return a.listExtract(await res.json());
}

export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`No JSON object in reply: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

export const providerLabel = () =>
  `${PROVIDER} - ${process.env.LLM_MODEL || ADAPTERS[PROVIDER]?.defaultModel} @ ${RPM}rpm`;

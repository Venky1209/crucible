// Talking to somebody else's deployed agent over HTTP.
//
// This is what makes Crucible test a REAL agent rather than a reconstruction of
// one from its prompt. Nothing else in the codebase changes: the adversaries,
// the judge and the report never learn where a reply came from.
//
// Only ever point this at an agent you own or are authorised to test.

const TIMEOUT_MS = Number(process.env.ENDPOINT_TIMEOUT_MS || 30000);

/**
 * Platform presets. Picking one sets the request shape, fills the URL, states
 * the EXACT auth header, and links straight to where that key is issued.
 * Verified against each vendor's own docs, not recalled - a wrong header means
 * a user's first run fails and they blame us.
 *
 * auth     : the literal header line to paste, '' when none is needed
 * authNote : the gotcha, where there is one
 * docs     : so nobody has to take our word for it
 * keyUrl   : the page that issues the key - one click, no hunting
 * keyWhere : for local tools that have no console to link to
 *
 * Freshworks Freddy is deliberately absent - no public chat endpoint is
 * documented, and a guessed shape is worse than none. Use Custom.
 */
export const PLATFORMS = [
  { id:'openai', name:'OpenAI', style:'openai', icon:'hex',
    url:'https://api.openai.com/v1/chat/completions',
    auth:'Authorization: Bearer sk-...',
    authNote:'',
    docs:'https://platform.openai.com/docs/api-reference/authentication', keyUrl:'https://platform.openai.com/api-keys', keyWhere:'' },
  { id:'anthropic', name:'Anthropic', style:'anthropic', icon:'star',
    url:'https://api.anthropic.com/v1/messages',
    auth:'x-api-key: sk-ant-...',
    authNote:'Not Bearer. Crucible adds anthropic-version: 2023-06-01 for you.',
    docs:'https://docs.anthropic.com/en/api/getting-started', keyUrl:'https://console.anthropic.com/settings/keys', keyWhere:'' },
  { id:'gemini', name:'Gemini', style:'gemini', icon:'spark',
    url:'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    auth:'x-goog-api-key: AIza...',
    authNote:'Header, not a ?key= query parameter.',
    docs:'https://ai.google.dev/gemini-api/docs/api-key', keyUrl:'https://aistudio.google.com/apikey', keyWhere:'' },
  { id:'groq', name:'Groq', style:'openai', icon:'bolt',
    url:'https://api.groq.com/openai/v1/chat/completions',
    auth:'Authorization: Bearer gsk_...',
    authNote:'',
    docs:'https://console.groq.com/docs/api-reference', keyUrl:'https://console.groq.com/keys', keyWhere:'' },
  { id:'openrouter', name:'OpenRouter', style:'openai', icon:'route',
    url:'https://openrouter.ai/api/v1/chat/completions',
    auth:'Authorization: Bearer sk-or-v1-...',
    authNote:'Keys begin sk-or-v1-, not sk-.',
    docs:'https://openrouter.ai/docs/api-reference/authentication', keyUrl:'https://openrouter.ai/keys', keyWhere:'' },
  { id:'ollama', name:'Ollama', style:'openai', icon:'box',
    url:'http://localhost:11434/v1/chat/completions',
    auth:'',
    authNote:'No auth when running locally. Ollama Cloud needs Authorization: Bearer <key>.',
    docs:'https://github.com/ollama/ollama/blob/main/docs/openai.md', keyUrl:'', keyWhere:'Runs locally with no key. For Ollama Cloud, keys live at ollama.com under Settings.' },
  { id:'lmstudio', name:'LM Studio', style:'openai', icon:'slider',
    url:'http://localhost:1234/v1/chat/completions',
    auth:'',
    authNote:'No auth. Start the local server from the Developer tab first.',
    docs:'https://lmstudio.ai/docs/app/api/endpoints/openai', keyUrl:'', keyWhere:'Runs locally with no key. Start the local server from the LM Studio Developer tab.' },
  { id:'dify', name:'Dify', style:'query', icon:'layers',
    url:'https://api.dify.ai/v1/chat-messages',
    auth:'Authorization: Bearer app-...',
    authNote:'App-scoped key, begins app-.',
    docs:'https://docs.dify.ai/en/use-dify/publish/developing-with-apis', keyUrl:'https://cloud.dify.ai/apps', keyWhere:'Open your app, then API Access, then the API key panel.' },
  { id:'flowise', name:'Flowise', style:'question', icon:'nodes',
    url:'http://localhost:3000/api/v1/prediction/YOUR_FLOW_ID',
    auth:'',
    authNote:'Only if you enabled an API key on the flow, then Authorization: Bearer <key>.',
    docs:'https://docs.flowiseai.com/using-flowise/api', keyUrl:'', keyWhere:'In your own Flowise UI: Settings, then API Keys. Only needed if you enabled it.' },
  { id:'langserve', name:'LangServe', style:'input', icon:'link',
    url:'http://localhost:8000/invoke',
    auth:'',
    authNote:'No auth by default - whatever your deployment added.',
    docs:'https://python.langchain.com/docs/langserve/', keyUrl:'', keyWhere:'No key unless your deployment added auth.' },
  { id:'voiceflow', name:'Voiceflow', style:'voiceflow', icon:'wave',
    url:'https://general-runtime.voiceflow.com/state/user/USER_ID/interact',
    auth:'Authorization: VF.DM....',
    authNote:'NO Bearer prefix - the raw key goes straight in. Replace USER_ID in the URL.',
    docs:'https://docs.voiceflow.com/reference/authentication', keyUrl:'https://creator.voiceflow.com', keyWhere:'Open your project, then Integrations, then the Dialog API key.' },
  { id:'botpress', name:'Botpress', style:'botpress', icon:'chat',
    url:'http://localhost:3000/api/v1/bots/BOT_ID/converse/USER_ID',
    auth:'',
    authNote:'v12 self-hosted converse is public. Botpress Cloud needs Authorization: Bearer <personal access token>.',
    docs:'https://botpress.com/docs/api-reference/authentication/', keyUrl:'https://app.botpress.cloud', keyWhere:'Cloud only: Profile Settings, then Personal Access Tokens.' },
  { id:'webhook', name:'Custom', style:'messages', icon:'plug',
    url:'https://your-agent.example.com/chat',
    auth:'',
    authNote:'Whatever your endpoint requires - add it as a header line.',
    docs:'', keyUrl:'', keyWhere:'Whatever your own endpoint requires.' },
];

/** Request shapes we can speak. */
export const STYLES = {
  openai: {
    label: 'OpenAI-compatible  (/chat/completions)',
    build: (history, t) => ({ model: t.model || 'default', messages: history }),
  },
  messages: {
    label: 'Webhook — full history  { messages: [...] }',
    build: (history) => ({ messages: history }),
  },
  single: {
    label: 'Webhook — latest turn  { message, history }',
    build: (history) => ({
      message: history[history.length - 1]?.content || '',
      history: history.slice(0, -1),
    }),
  },
  anthropic: {
    label: 'Anthropic Messages API  (/v1/messages)',
    build: (history, t) => ({
      model: t.model || 'claude-opus-5',
      max_tokens: 1024,
      messages: history,
    }),
    // needs x-api-key + anthropic-version, which the user supplies as headers
    headers: { 'anthropic-version': '2023-06-01' },
  },
  query: {
    label: 'Dify-style  { query, user }',
    build: (history) => ({
      query: history[history.length - 1]?.content || '',
      user: 'crucible-test',
      inputs: {},
      response_mode: 'blocking',
    }),
  },
  question: {
    label: 'Flowise-style  { question }',
    build: (history) => ({ question: history[history.length - 1]?.content || '' }),
  },
  input: {
    label: 'LangServe-style  { input }',
    build: (history) => ({ input: history[history.length - 1]?.content || '' }),
  },
  gemini: {
    label: 'Google Gemini  (:generateContent)',
    build: (history) => ({
      contents: history.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    }),
  },
  voiceflow: {
    label: 'Voiceflow Dialog API  (/interact)',
    build: (history) => ({
      action: { type: 'text', payload: history[history.length - 1]?.content || '' },
      config: { tts: false, stripSSML: true },
    }),
  },
  botpress: {
    label: 'Botpress Converse  (/converse/:userId)',
    build: (history) => ({ type: 'text', text: history[history.length - 1]?.content || '' }),
  },
};

// Ordered by specificity. First hit wins.
const REPLY_PATHS = [
  ['choices', 0, 'message', 'content'],
  ['choices', 0, 'text'],
  ['content', 0, 'text'],              // Anthropic Messages API
  ['candidates', 0, 'content', 'parts', 0, 'text'],            // Gemini
  ['output', 'content', 0, 'text'],
  ['message', 'content'],
  ['data', 'answer'],                  // Dify
  ['outputs', 0, 'outputs', 0, 'results', 'message', 'text'],  // Langflow
  ['data', 'reply'], ['data', 'response'], ['data', 'message'], ['data', 'text'],
  ['reply'], ['response'], ['answer'], ['output'], ['text'], ['content'], ['message'],
  ['result'],
];

const dig = (obj, path) => path.reduce((o, k) => (o == null ? o : o[k]), obj);

/** Pull the assistant's text out of whatever shape came back. */
export function extractReply(data) {
  if (typeof data === 'string' && data.trim()) return data.trim();

  // Botpress leads with a typing indicator, so the reply is not at index 0.
  if (Array.isArray(data?.responses)) {
    const said = data.responses
      .map((r) => r?.text ?? r?.value)
      .filter((x) => typeof x === 'string' && x.trim());
    if (said.length) return said.join(' ').trim();
  }

  // Voiceflow replies with a bare array of traces; join the spoken ones.
  if (Array.isArray(data)) {
    const said = data
      .map((t) => t?.payload?.message ?? t?.payload?.text ?? t?.text)
      .filter((x) => typeof x === 'string' && x.trim());
    if (said.length) return said.join(' ').trim();
  }
  for (const path of REPLY_PATHS) {
    const v = dig(data, path);
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  throw new Error(
    'Could not find the reply in the response. Shape received: ' +
    JSON.stringify(data).slice(0, 220),
  );
}

/** Parse "Key: value" lines into a headers object. */
export function parseHeaders(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/** Reject anything that is not a plain http(s) URL. */
export function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Endpoint must be http:// or https://');
  }
  return u.toString();
}

/**
 * One turn against a live agent.
 * target = { url, headers?, style?, model? }
 * history = [{ role: 'user' | 'assistant', content }]
 */
export async function endpointReply(target, history) {
  const style = STYLES[target.style] ? target.style : 'openai';
  const body = STYLES[style].build(history, target);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(STYLES[style].headers || {}),
        ...(target.headers || {}),
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });

    const raw = await res.text();
    if (!res.ok) throw new Error(`Target returned HTTP ${res.status}: ${raw.slice(0, 200)}`);

    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    return extractReply(parsed);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Target did not respond within ${TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** One cheap round-trip so the user finds out now, not 4 turns into a run. */
export async function probeEndpoint(target) {
  const started = Date.now();
  const reply = await endpointReply(target, [{ role: 'user', content: 'Hello, are you there?' }]);
  return { ok: true, ms: Date.now() - started, sample: reply.slice(0, 240) };
}

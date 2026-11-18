import express from 'express';
import { randomUUID } from 'node:crypto';
import { LIBRARY, ADVERSARIES } from './src/adversaries.js';
import { DEFAULT_TARGET_PROMPT, TARGETS } from './src/target.js';
import { runAll, groupFailures, summarize, TURNS_PER_ATTACK } from './src/run.js';
import { FAILURE_MODES } from './src/judge.js';
import { providerLabel, providerReady, limits, usage, llmContext } from './src/llm.js';
import { STYLES, PLATFORMS, parseHeaders, validateUrl, probeEndpoint } from './src/endpoint.js';
import { voiceReady, renderTranscript } from './src/voice.js';
import { voiceModeReady, voiceModeStatus } from './src/voice-target.js';
import { extractBest } from './src/extract.js';
import { DETAIL } from './src/detail.js';

const app = express();
app.use(express.json({ limit: '8mb' }));
// No caching in dev. A stale avatar.js whose exports have changed breaks the
// module import and blanks the whole page - a confusing failure to debug.
app.use(express.static('public', {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store, must-revalidate'),
}));

// On Vercel the CDN serves public/, but the bare "/" reaches this function, so send the landing page here.
app.get('/', (_req, res) => res.sendFile('index.html', { root: 'public' }));

// In-memory only. The process lives as long as the demo. (Trap #6: no persistence.)
const runs = new Map();

app.get('/api/config', (_req, res) => {
  res.json({
    library: LIBRARY.map(({ id, name, blurb, goal, color, icon, tagline, principle, source }) =>
      ({ id, name, blurb, goal, color, icon, tagline, principle, source, ...(DETAIL[id] || {}) })),
    defaultActive: ADVERSARIES.map((a) => a.id),
    defaultPrompt: DEFAULT_TARGET_PROMPT,
    targets: TARGETS,
    failureModes: FAILURE_MODES,
    turns: TURNS_PER_ATTACK,
    styles: Object.entries(STYLES).map(([id, v]) => ({ id, label: v.label })),
    platforms: PLATFORMS,
    provider: providerLabel(),
    hosted: HOSTED, caps: CAPS, sharedKey: serverKeyReady(), liveTargets: !HOSTED || ALLOW_LIVE,
    voice: voiceReady(),
    voiceMode: voiceModeStatus(),
  });
});

/** Lines present in the current prompt but not the baseline = the user's fixes. */
function defencesAdded(baseline, current) {
  if (!baseline || !current) return '';
  const split = (t) => String(t).split(/\r?\n/).map((l) => l.trim());
  const before = new Set(split(baseline));
  return split(current).filter((l) => l && !before.has(l)).join('\n');
}

/** Turn the request body into a target the runner understands. Throws on bad input. */
function buildTarget(body) {
  const { mode, targetPrompt, url, headers, style, model, authorised, languageCode } = body || {};
  if (mode === 'voice') {
    if (!authorised) throw new Error('You must confirm you own or are authorised to test this agent.');
    if (!voiceModeReady()) throw new Error('Voice mode needs: ' + voiceModeStatus().missing.join(' and '));
    return {
      mode: 'voice',
      url: validateUrl(url),
      headers: typeof headers === 'string' ? parseHeaders(headers) : (headers || {}),
      languageCode: languageCode || 'hi-IN',
    };
  }
  if (mode === 'endpoint') {
    if (!authorised) {
      throw new Error('You must confirm you own or are authorised to test this endpoint.');
    }
    return {
      mode: 'endpoint',
      url: validateUrl(url),
      headers: typeof headers === 'string' ? parseHeaders(headers) : (headers || {}),
      style: STYLES[style] ? style : 'openai',
      model,
    };
  }
  if (!targetPrompt?.trim()) throw new Error('targetPrompt is required');
  return { mode: 'prompt', prompt: targetPrompt };
}

/** Find the agent definition in whatever the user dropped in. */
app.post('/api/extract', (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ found: false, reason: 'No files received.' });
  try {
    res.json(extractBest(files.filter((f) => f && typeof f.text === 'string')));
  } catch (err) {
    res.status(400).json({ found: false, reason: err.message });
  }
});

/** Render one attack transcript as audio. Absent unless ELEVENLABS_API_KEY is set. */
app.post('/api/voice', async (req, res) => {
  try {
    const { transcript } = req.body || {};
    if (!Array.isArray(transcript) || !transcript.length) {
      return res.status(400).json({ error: 'transcript required' });
    }
    const { audio, turns } = await renderTranscript(transcript);
    res.set({ 'Content-Type': 'audio/mpeg', 'X-Turns-Rendered': String(turns) }).send(audio);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Cheap round-trip so a bad URL fails in 2 seconds, not 4 turns in. */
app.post('/api/probe', async (req, res) => {
  if (HOSTED && !ALLOW_LIVE) return res.status(403).json({ error: 'The hosted demo tests prompts only. Probe live endpoints from your own machine with the CLI.' });
  try {
    const target = buildTarget({ ...req.body, mode: 'endpoint' });
    res.json(await probeEndpoint(target));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/run', (req, res) => {
  const blocked = hostedGuard(req, req.body);
  if (blocked) return res.status(403).json({ error: blocked });
  const { adversaryIds } = req.body || {};
  const chosen = (adversaryIds?.length ? adversaryIds : ADVERSARIES.map((a) => a.id))
    .map((id) => LIBRARY.find((a) => a.id === id))
    .filter(Boolean);

  let target;
  try { target = buildTarget(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  if (!chosen.length) return res.status(400).json({ error: 'pick at least one adversary' });

  const runId = randomUUID();
  runs.set(runId, { events: [], done: false, listeners: new Set(), adversaries: chosen });
  res.json({ runId, adversaries: chosen.map(({ id, name, blurb, goal, color, icon, tagline, principle }) =>
    ({ id, name, blurb, goal, color, icon, tagline, principle })) });

  const run = runs.get(runId);
  const emit = (e) => {
    run.events.push(e);
    for (const write of run.listeners) write(e);
  };

  // Round 2+ tells each adversary what defence it now faces and how it opened
  // last time, so it routes around instead of repeating itself.
  const { round = 1, baselinePrompt, prior } = req.body || {};
  const defences = defencesAdded(baselinePrompt, req.body?.targetPrompt);
  const ctx = {
    round: Number(round) || 1,
    defences,
    per: Object.fromEntries((chosen || []).map((a) => [a.id, {
      priorOpening: prior?.[a.id]?.opening,
      priorOutcome: prior?.[a.id]?.outcome,
    }])),
  };

  runAll(chosen, target, { onEvent: emit, ctx })
    .then((results) => {
      emit({
        type: 'done',
        groups: groupFailures(results).map((g) => ({
          mode: g.mode,
          count: g.count,
          items: g.items.map((r) => ({
            adversaryId: r.adversary.id,
            adversaryName: r.adversary.name,
            evidence: r.verdict.evidence,
            why: r.verdict.why,
            severity: r.verdict.severity,
            standard: FAILURE_MODES[r.verdict.mode]?.standard || null,
            fix: r.verdict.fix,
            transcript: r.transcript,
          })),
        })),
        total: results.length,
        failed: results.filter((r) => r.verdict.failed).length,
        round: ctx.round,
        defences,
        // what each attacker opened with, so the next round can avoid repeating it
        openings: Object.fromEntries(results.map((r) => [
          r.adversary.id,
          {
            opening: r.transcript.find((t) => t.role === 'adversary')?.content?.slice(0, 120),
            outcome: r.verdict.failed ? `you succeeded via ${r.verdict.mode}` : 'the agent held; that route is closed',
          },
        ])),
        limits,
      });
      run.done = true;
    })
    .catch((err) => {
      emit({ type: 'error', message: err.message });
      run.done = true;
    });
});

// ── v2: one-request streaming run ────────────────────────────────────────────
// The run above keeps state in memory between two requests, which breaks on serverless hosts where
// each request can land on a different machine. This endpoint runs and streams in ONE response as
// newline-delimited JSON, with a heartbeat so idle proxies don't close it.
//
// Bring your own key: x-crucible-key / x-crucible-provider / x-crucible-model / x-crucible-base apply
// to this request only. Without one, a hosted deployment (HOSTED=1) runs on the server's key with caps.
const HOSTED = process.env.HOSTED === '1' || Boolean(process.env.VERCEL);
const CAPS = { attackers: 3, turns: 4, trials: 2, votes: 1 };

// A public deployment tests PROMPTS only. Pointing a shared server at live agents or web pages would let
// anyone send attack traffic to a bot they do not own, from our address, so those modes stay on the
// visitor's own machine (the CLI) unless the operator opts in with ALLOW_HOSTED_ENDPOINTS=1.
const ALLOW_LIVE = process.env.ALLOW_HOSTED_ENDPOINTS === '1';
const PROVIDER_NAME = process.env.LLM_PROVIDER || 'openai';
const serverKeyReady = () => PROVIDER_NAME === 'mock' || providerReady(PROVIDER_NAME);

function unsafeBase(raw) {
  let u; try { u = new URL(raw); } catch { return 'That base URL is not valid.'; }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:') return 'The base URL must use https.';
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || /^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return 'The base URL must be a public provider address, not a local or IP address.';
  return null;
}

/** Returns an error message when a hosted request is not allowed, else null. */
function hostedGuard(req, body) {
  if (!HOSTED) return null;
  if ((body?.mode === 'endpoint' || body?.mode === 'voice') && !ALLOW_LIVE) {
    return 'The hosted demo tests prompts only. To test a live agent or a website you own, run Crucible on your machine: node cli.js --endpoint <url> --authorised, or --url <page> --authorised.';
  }
  const base = req.get('x-crucible-base');
  if (base) { const bad = unsafeBase(base); if (bad) return bad; }
  if (!req.get('x-crucible-key') && !serverKeyReady()) {
    return 'This demo has no shared model key right now. Add your own free key in the key panel: Groq keys are free at console.groq.com/keys.';
  }
  return null;
}

app.post('/api/run-stream', async (req, res) => {
  const body = req.body || {};
  const blocked = hostedGuard(req, body);
  if (blocked) return res.status(403).json({ error: blocked });
  const own = req.get('x-crucible-key')
    ? { key: req.get('x-crucible-key'), provider: req.get('x-crucible-provider') || 'openai',
        model: req.get('x-crucible-model') || undefined, base: req.get('x-crucible-base') || undefined }
    : null;
  if (own && own.base) {
    try { validateUrl(own.base); } catch (err) { return res.status(400).json({ error: 'Bad base URL: ' + err.message }); }
  }
  const capped = HOSTED && !own;
  let chosen = (body.adversaryIds?.length ? body.adversaryIds : ADVERSARIES.map((a) => a.id))
    .map((id) => LIBRARY.find((a) => a.id === id)).filter(Boolean);
  let trials = Math.max(1, Math.min(10, Number(body.trials) || 1));
  let votes = [1, 3].includes(Number(body.votes)) ? Number(body.votes) : 1;
  let turns = Math.max(2, Math.min(8, Number(body.turns) || TURNS_PER_ATTACK));
  if (capped) {
    chosen = chosen.slice(0, CAPS.attackers);
    trials = Math.min(trials, CAPS.trials); votes = CAPS.votes; turns = Math.min(turns, CAPS.turns);
  }
  let target;
  try { target = buildTarget(body); } catch (err) { return res.status(400).json({ error: err.message }); }
  if (typeof body.policy === 'string' && body.policy.trim()) target.policy = body.policy.slice(0, 20000);
  if (!chosen.length) return res.status(400).json({ error: 'pick at least one adversary' });

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const write = (e) => res.write(JSON.stringify(e) + '\n');
  const beat = setInterval(() => write({ type: 'heartbeat' }), 10000);
  write({ type: 'start', capped, trials, votes, turns,
    adversaries: chosen.map(({ id, name, blurb, goal, color, icon, tagline, principle }) => ({ id, name, blurb, goal, color, icon, tagline, principle })) });

  const { round = 1, baselinePrompt, prior } = body;
  const defences = defencesAdded(baselinePrompt, body.targetPrompt);
  const ctx = { round: Number(round) || 1, defences,
    per: Object.fromEntries(chosen.map((a) => [a.id, { priorOpening: prior?.[a.id]?.opening, priorOutcome: prior?.[a.id]?.outcome }])) };
  const before = usage.calls;
  try {
    let gaps = [];
    const results = await llmContext.run(own || {}, () => runAll(chosen, target, { onEvent: (e) => { if (e.type === 'recon') gaps = e.gaps; write(e); }, ctx, trials, votes, turns }));
    write({
      type: 'done',
      gaps,
      summary: summarize(results),
      groups: groupFailures(results).map((g) => ({
        mode: g.mode, count: g.count,
        items: g.items.map((r) => ({ adversaryId: r.adversary.id, adversaryName: r.adversary.name, trial: r.trial,
          evidence: r.verdict.evidence, rule: r.verdict.rule || null, why: r.verdict.why, severity: r.verdict.severity, jury: r.verdict.jury || null,
          standard: FAILURE_MODES[r.verdict.mode]?.standard || null, fix: r.verdict.fix, transcript: r.transcript })),
      })),
      total: results.length, failed: results.filter((r) => r.verdict.failed).length, round: ctx.round, defences,
      openings: Object.fromEntries(results.map((r) => [r.adversary.id, {
        opening: r.transcript.find((t) => t.role === 'adversary')?.content?.slice(0, 120),
        outcome: r.verdict.failed ? `you succeeded via ${r.verdict.mode}` : 'the agent held; that route is closed' }])),
      calls: usage.calls - before,
    });
  } catch (err) {
    write({ type: 'error', message: err.message });
  } finally {
    clearInterval(beat);
    res.end();
  }
});

app.get('/api/events/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  run.events.forEach(write);          // replay anything already emitted
  if (run.done) return res.end();

  // Rate-limited runs can pause for a minute between turns. Without a heartbeat
  // a proxy, browser, or HTTP client body-timeout drops the stream mid-attack
  // and the UI simply stops with no error.
  const beat = setInterval(() => res.write(': keepalive\n\n'), 15000);

  run.listeners.add(write);
  req.on('close', () => { clearInterval(beat); run.listeners.delete(write); });
});

// On Vercel the app is exported and served as one function; locally it listens.
export default app;
const port = process.env.PORT || 3100;
if (!process.env.VERCEL) app.listen(port, () => {
  console.log(`\n  CRUCIBLE  ->  http://localhost:${port}`);
  console.log(`  ${providerLabel()}  ${TURNS_PER_ATTACK} turns/attack\n`);
});

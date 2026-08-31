import express from 'express';
import { randomUUID } from 'node:crypto';
import { LIBRARY, ADVERSARIES } from './src/adversaries.js';
import { DEFAULT_TARGET_PROMPT, TARGETS } from './src/target.js';
import { runAll, groupFailures, TURNS_PER_ATTACK } from './src/run.js';
import { FAILURE_MODES } from './src/judge.js';
import { providerLabel, limits } from './src/llm.js';
import { STYLES, PLATFORMS, parseHeaders, validateUrl, probeEndpoint } from './src/endpoint.js';
import { voiceReady, renderTranscript } from './src/voice.js';
import { voiceModeReady, voiceModeStatus } from './src/voice-target.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
// No caching in dev. A stale avatar.js whose exports have changed breaks the
// module import and blanks the whole page - a confusing failure to debug.
app.use(express.static('public', {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store, must-revalidate'),
}));

// In-memory only. The process lives as long as the demo. (Trap #6: no persistence.)
const runs = new Map();

app.get('/api/config', (_req, res) => {
  res.json({
    library: LIBRARY.map(({ id, name, blurb, goal, color, icon, tagline, principle, source }) =>
      ({ id, name, blurb, goal, color, icon, tagline, principle, source })),
    defaultActive: ADVERSARIES.map((a) => a.id),
    defaultPrompt: DEFAULT_TARGET_PROMPT,
    targets: TARGETS,
    failureModes: FAILURE_MODES,
    turns: TURNS_PER_ATTACK,
    styles: Object.entries(STYLES).map(([id, v]) => ({ id, label: v.label })),
    platforms: PLATFORMS,
    provider: providerLabel(),
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
  try {
    const target = buildTarget({ ...req.body, mode: 'endpoint' });
    res.json(await probeEndpoint(target));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/run', (req, res) => {
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

const port = process.env.PORT || 3100;
app.listen(port, () => {
  console.log(`\n  CRUCIBLE  ->  http://localhost:${port}`);
  console.log(`  ${providerLabel()}  ${TURNS_PER_ATTACK} turns/attack\n`);
});

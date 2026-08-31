import { adversaryReply } from './adversaries.js';
import { targetReply } from './target.js';
import { judgeTranscript } from './judge.js';

export const TURNS_PER_ATTACK = Number(process.env.TURNS || 4);

/**
 * Run one adversary against the target for N exchanges.
 * onEvent({type, ...}) fires per turn so the UI can fill in live.
 */
export async function runAttack(adversary, target, { turns = TURNS_PER_ATTACK, onEvent = () => {}, ctx = {} } = {}) {
  const transcript = [];   // canonical: [{ role: 'adversary' | 'target', content }]
  const tgtView = [];      // the target's own message list (it is the 'assistant')

  onEvent({ type: 'attack_start', adversaryId: adversary.id });

  for (let i = 0; i < turns; i++) {
    const attack = await adversaryReply(adversary, transcript, ctx);
    transcript.push({ role: 'adversary', content: attack });
    tgtView.push({ role: 'user', content: attack });
    onEvent({ type: 'turn', adversaryId: adversary.id, role: 'adversary', content: attack, index: transcript.length });

    const reply = await targetReply(target, tgtView);
    transcript.push({ role: 'target', content: reply });
    tgtView.push({ role: 'assistant', content: reply });
    onEvent({ type: 'turn', adversaryId: adversary.id, role: 'target', content: reply, index: transcript.length });
  }

  const verdict = await judgeTranscript(transcript, adversary);
  onEvent({ type: 'verdict', adversaryId: adversary.id, verdict });
  return { adversary, transcript, verdict };
}

/** Run several adversaries at once, capped so a free tier does not 429 mid-demo. */
export async function runAll(adversaries, target, { concurrency = 2, onEvent = () => {}, turns, ctx = {} } = {}) {
  const results = [];
  for (let i = 0; i < adversaries.length; i += concurrency) {
    const wave = adversaries.slice(i, i + concurrency);
    results.push(...(await Promise.all(wave.map((a) =>
        runAttack(a, target, { turns, onEvent, ctx: { ...ctx, ...(ctx.per?.[a.id] || {}) } })))));
  }
  return results;
}

/** Group failures by mode - the judge already labelled them, so no clustering needed. */
export function groupFailures(results) {
  const byMode = new Map();
  for (const r of results) {
    if (!r.verdict.failed) continue;
    if (!byMode.has(r.verdict.mode)) byMode.set(r.verdict.mode, []);
    byMode.get(r.verdict.mode).push(r);
  }
  return [...byMode.entries()]
    .map(([mode, items]) => ({ mode, count: items.length, items }))
    .sort((a, b) => b.count - a.count);
}

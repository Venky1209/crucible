import { adversaryReply } from './adversaries.js';
import { targetReply } from './target.js';
import { judgeTranscript } from './judge.js';

export const TURNS_PER_ATTACK = Number(process.env.TURNS || 4);

/**
 * Run one adversary against the target for N exchanges.
 * onEvent({type, ...}) fires per turn so the UI can fill in live.
 */
export async function runAttack(adversary, target, { turns = TURNS_PER_ATTACK, onEvent = () => {}, ctx = {}, trial = 1, votes = 1 } = {}) {
  const transcript = [];   // canonical: [{ role: 'adversary' | 'target', content }]
  const tgtView = [];      // the target's own message list (it is the 'assistant')

  onEvent({ type: 'attack_start', adversaryId: adversary.id, trial });

  // Browser mode keeps one real page per conversation; a fresh context per trial, so no memory leaks between runs.
  let conv = null;
  if (target.mode === 'browser') {
    const { openBrowserConversation } = await import('./browser-target.js');
    conv = await openBrowserConversation(target);
    onEvent({ type: 'browser', adversaryId: adversary.id, trial, via: conv.via });
  }
  try {
  for (let i = 0; i < turns; i++) {
    const attack = await adversaryReply(adversary, transcript, ctx);
    transcript.push({ role: 'adversary', content: attack });
    tgtView.push({ role: 'user', content: attack });
    onEvent({ type: 'turn', adversaryId: adversary.id, role: 'adversary', content: attack, index: transcript.length, trial });

    const reply = conv ? await conv.send(attack) : await targetReply(target, tgtView);
    transcript.push({ role: 'target', content: reply });
    tgtView.push({ role: 'assistant', content: reply });
    onEvent({ type: 'turn', adversaryId: adversary.id, role: 'target', content: reply, index: transcript.length, trial });
    // A real person may now be on the other end. Stop: red-team traffic must never reach support staff.
    if (conv?.handover) { onEvent({ type: 'handover', adversaryId: adversary.id, trial }); break; }
  }
  } finally {
    await conv?.close();
  }

  const verdict = await judgeTranscript(transcript, adversary, { votes });
  if (conv?.handover) verdict.handover = true;
  onEvent({ type: 'verdict', adversaryId: adversary.id, verdict, trial });
  return { adversary, transcript, verdict, trial };
}

/**
 * Run several adversaries, each `trials` times, capped so a free tier does not 429 mid-demo.
 * Trials of one attacker run one after another; attackers in a wave run side by side.
 */
export async function runAll(adversaries, target, { concurrency = 2, onEvent = () => {}, turns, ctx = {}, trials = 1, votes = 1 } = {}) {
  const results = [];
  for (let i = 0; i < adversaries.length; i += concurrency) {
    const wave = adversaries.slice(i, i + concurrency);
    const done = await Promise.all(wave.map(async (a) => {
      const mine = [];
      for (let t = 1; t <= trials; t++) {
        mine.push(await runAttack(a, target, { turns, onEvent, trial: t, votes, ctx: { ...ctx, ...(ctx.per?.[a.id] || {}) } }));
      }
      return mine;
    }));
    results.push(...done.flat());
  }
  return results;
}

export { summarize } from './stats.js';

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

// Turns a run into a report a reviewer can read (Markdown) and a machine can diff (JSON).
import { FAILURE_MODES } from './judge.js';

const ci = (c) => `${c[0]}–${c[1]}%`;

export function toJson(meta, summary, results) {
  return {
    tool: 'crucible', version: meta.version, when: meta.when, target: meta.target, model: meta.model,
    settings: { trials: meta.trials, turns: meta.turns, votes: meta.votes },
    summary,
    findings: results.filter((r) => r.verdict.failed).map((r) => ({
      attacker: r.adversary.name, trial: r.trial, mode: r.verdict.mode,
      standard: FAILURE_MODES[r.verdict.mode]?.standard || null, severity: r.verdict.severity,
      evidence: r.verdict.evidence, rule: r.verdict.rule || null, why: r.verdict.why, fix: r.verdict.fix, jury: r.verdict.jury || null,
      transcript: r.transcript,
    })),
    policyGaps: meta.recon || [],
    usage: meta.usage,
  };
}

export function toMarkdown(meta, summary, results) {
  const L = [];
  L.push(`# Crucible report: ${meta.target}`, '');
  L.push(`${meta.when} · model: ${meta.model} · ${meta.trials} trial(s) × ${meta.turns} turns per attacker · judge votes: ${meta.votes}`, '');
  L.push(`**Resistance score: ${summary.resistance}/100.** Attack success rate ${summary.asr}% ` +
    `(95% CI ${ci(summary.ci)}, ${summary.failures} of ${summary.trials} conversations). ` +
    `Held against ${summary.passK.value}% of attackers in all ${summary.passK.k} trials (pass^${summary.passK.k}).`, '');
  L.push('| Attacker | Principle | Broke it | Rate | 95% CI |', '|---|---|---|---|---|');
  for (const a of summary.attackers) L.push(`| ${a.name} | ${a.principle} | ${a.failures} of ${a.trials} | ${a.asr}% | ${ci(a.ci)} |`);
  if (meta.recon && meta.recon.length) {
    L.push('', '## Weak points in your policy', '', 'Crucible read your policy before attacking. Each line below is quoted from it.', '');
    for (const g of meta.recon) L.push(`- **${g.type.replace('_', ' ').toLowerCase()}**: "${g.quote}". ${g.weakness}`);
  }
  const fails = results.filter((r) => r.verdict.failed);
  if (fails.length) {
    L.push('', '## Findings', '');
    const seen = new Set();
    for (const r of fails) {
      const key = r.adversary.id + r.verdict.mode;
      if (seen.has(key)) continue;
      seen.add(key);
      L.push(`### ${r.verdict.mode} · found by ${r.adversary.name} (${r.verdict.severity})`);
      L.push(`${FAILURE_MODES[r.verdict.mode]?.standard || ''}`, '');
      L.push(`> Your agent said: "${r.verdict.evidence}"`, '');
      if (r.verdict.rule) L.push(`Rule it broke: "${r.verdict.rule}"`, '');
      if (r.verdict.jury) L.push(`Judge agreement: ${r.verdict.jury.fail} of ${r.verdict.jury.total} votes.`, '');
      if (r.verdict.fix) L.push('Add to your system prompt:', '', '```', r.verdict.fix, '```', '');
    }
  } else {
    L.push('', 'No attacker got through in this run.');
  }
  L.push('', `_Small samples have wide intervals. Re-run with more trials before trusting a single number. ${meta.usage.calls} model calls._`);
  return L.join('\n');
}

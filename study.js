#!/usr/bin/env node
// Which models fold to which persuasion principle? Runs the same agent prompt on several models.
// Only the AGENT's model changes; the attackers and the judge stay on the default provider, so the
// comparison is fair. Writes study/results-<date>.md.
//
//   node --env-file=.env study.js --models "openai:llama-3.3-70b-versatile,gemini:gemini-2.5-flash" --target northwind --attackers all --trials 3
//
// Model specs are provider:model. Each provider needs its key in .env (LLM_API_KEY, GEMINI_API_KEY).
import { mkdirSync, writeFileSync } from 'node:fs';
import { LIBRARY, ADVERSARIES } from './src/adversaries.js';
import { TARGETS } from './src/target.js';
import { runAll, summarize, TURNS_PER_ATTACK } from './src/run.js';
import { providerLabel, usage } from './src/llm.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const specs = opt('models', '').split(',').map((s) => s.trim()).filter(Boolean);
if (!specs.length) { console.error('Give --models "provider:model,provider:model"'); process.exit(2); }
const t = TARGETS.find((x) => x.id === opt('target', 'northwind'));
const pick = opt('attackers');
const team = !pick ? ADVERSARIES : pick === 'all' ? LIBRARY : pick.split(',').map((id) => LIBRARY.find((a) => a.id === id.trim())).filter(Boolean);
const trials = Number(opt('trials', 3)), turns = Number(opt('turns', TURNS_PER_ATTACK));

const rows = [];
for (const spec of specs) {
  const [provider, ...rest] = spec.split(':');
  const model = rest.join(':');
  console.log(`\n${spec} · ${t.name} · ${team.length} attackers × ${trials} trials`);
  const results = await runAll(team, { mode: 'prompt', prompt: t.prompt, provider, model }, { trials, turns,
    onEvent: (e) => e.type === 'verdict' && process.stdout.write(e.verdict.failed ? 'x' : '.') });
  const s = summarize(results);
  console.log(`\n  resistance ${s.resistance}/100 · ASR ${s.asr}% (CI ${s.ci[0]}–${s.ci[1]}%)`);
  rows.push({ spec, s });
}

const principles = [...new Set(rows.flatMap((r) => Object.keys(r.s.principles)))];
const day = new Date().toISOString().slice(0, 10);
const md = [
  `# Persuasion susceptibility by model: ${t.name}`, '',
  `${day} · ${team.length} attackers × ${trials} trials × ${turns} turns per model · attackers and judge: ${providerLabel()} · ${usage.calls} calls`, '',
  '| Agent model | Resistance | Attack success | 95% CI | pass^k |', '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.spec} | ${r.s.resistance}/100 | ${r.s.asr}% | ${r.s.ci[0]}–${r.s.ci[1]}% | ${r.s.passK.value}% (k=${r.s.passK.k}) |`),
  '', '## Attack success by persuasion principle', '',
  `| Principle | ${rows.map((r) => r.spec).join(' | ')} |`, `|---|${rows.map(() => '---').join('|')}|`,
  ...principles.map((p) => `| ${p} | ${rows.map((r) => (r.s.principles[p] ? r.s.principles[p].asr + '%' : '–')).join(' | ')} |`),
  '', '_Intervals are wide at small trial counts; treat differences inside overlapping intervals as noise._',
].join('\n');
mkdirSync('study', { recursive: true });
writeFileSync(`study/results-${day}.md`, md);
console.log(`\nWrote study/results-${day}.md`);

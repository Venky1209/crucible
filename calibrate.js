#!/usr/bin/env node
// Checks the judge against hand-labelled transcripts (calibration/set.json) and reports how often it
// agrees with the labels. Run it whenever you change the judge prompt or the judge model:
//   node --env-file=.env calibrate.js [--votes 3]
// Precision matters most: a judge that cries wolf makes every finding worthless.
import { readFileSync } from 'node:fs';
import { judgeTranscript } from './src/judge.js';
import { providerLabel, usage } from './src/llm.js';

const votesArg = process.argv.indexOf('--votes');
const votes = votesArg > 0 ? Number(process.argv[votesArg + 1]) || 1 : 1;
const { cases } = JSON.parse(readFileSync(new URL('./calibration/set.json', import.meta.url), 'utf8'));

console.log(`judge calibration · ${cases.length} labelled transcripts · ${votes} vote(s) · ${providerLabel()}\n`);
let tp = 0, fp = 0, tn = 0, fn = 0;
const wrong = [];
for (const c of cases) {
  const v = await judgeTranscript(c.transcript, { goal: c.goal }, { votes });
  const said = v.failed ? 'fail' : 'pass';
  if (c.label === 'fail' && said === 'fail') tp++;
  if (c.label === 'pass' && said === 'fail') { fp++; wrong.push(`${c.id}: judge said FAIL (${v.mode}) on a pass`); }
  if (c.label === 'pass' && said === 'pass') tn++;
  if (c.label === 'fail' && said === 'pass') { fn++; wrong.push(`${c.id}: judge said PASS on a ${c.mode}`); }
  console.log(`  ${said === c.label ? 'ok   ' : 'WRONG'} ${c.id}`);
}
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 100);
console.log(`\naccuracy ${pct(tp + tn, cases.length)}% · precision ${pct(tp, tp + fp)}% (of its FAIL calls, how many were real) · recall ${pct(tp, tp + fn)}% (of real failures, how many it caught) · ${usage.calls} calls`);
if (wrong.length) console.log('\n' + wrong.map((w) => '  ' + w).join('\n'));

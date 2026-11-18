#!/usr/bin/env node
// Writes the landing page's benchmark charts from the recorded runs in baseline/<date>/.
// The page never carries a number that is not in a report.json:
//   node scripts/landing-bench.mjs [baseline/2026-11-18]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dir = process.argv[2] || join('baseline', readdirSync(join(root, 'baseline')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop());
const read = (run) => {
  const f = join(root, dir, run, 'report.json');
  if (!existsSync(f)) return null;
  const r = JSON.parse(readFileSync(f, 'utf8'));
  return { k: r.summary.failures, n: r.summary.trials, unjudged: r.summary.unjudged || 0, roles: r.roles, settings: r.settings };
};
const runs = Object.fromEntries(['northwind', 'retail', 'airline', 'retail-no-recon', 'northwind-no-recon'].map((r) => [r, read(r)]));
const row = (name, tag, r) => ({ name, tag, k: r ? r.k : null, n: r ? r.n : null });

const any = Object.values(runs).find(Boolean);
const date = dir.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
const nice = date ? new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
const unjudged = Object.values(runs).filter(Boolean).reduce((n, r) => n + r.unjudged, 0);
const B = {
  byTarget: [
    row('An ordinary support prompt', 'Northwind', runs.northwind),
    row('τ-bench retail policy', 'published', runs.retail),
    row('τ-bench airline policy', 'published', runs.airline),
  ],
  recon: [
    row('Retail · reads the policy first', '', runs.retail),
    row('Retail · generic attackers', '', runs['retail-no-recon']),
    row('Ordinary prompt · reads the policy first', '', runs.northwind),
    row('Ordinary prompt · generic attackers', '', runs['northwind-no-recon']),
  ],
  meta: any ? `Crucible baseline, ${nice}. The agent: ${any.roles?.agent || 'n/a'}. Attackers: ${any.roles?.attacker || 'n/a'}. Judge: ${any.roles?.judge || 'n/a'}, which agreed with all 24 hand-labelled cases in calibration. `
    + `${any.settings?.trials || 3} trials per attacker, ${any.settings?.turns || 4} turns each, 5 attackers per target. `
    + (unjudged ? `${unjudged} conversation${unjudged === 1 ? '' : 's'} the judge could not score ${unjudged === 1 ? 'is' : 'are'} left out. ` : '')
    + 'Small samples, so the intervals are wide. Reproduce with <code>bash baseline.sh</code>.' : '',
};

const page = join(root, 'public', 'index.html');
const html = readFileSync(page, 'utf8');
const re = /\/\*@BENCH\*\/[\s\S]*?\/\*@END\*\//;
if (!re.test(html)) { console.error('No /*@BENCH*/ marker in public/index.html'); process.exit(1); }
writeFileSync(page, html.replace(re, () => `/*@BENCH*/${JSON.stringify(B)}/*@END*/`));
console.log(`benchmark charts written from ${dir}:`);
for (const r of [...B.byTarget, ...B.recon]) console.log(`  ${(r.name + ' ').padEnd(44, '.')} ${r.k == null ? 'not run yet' : `${r.k} of ${r.n}`}`);

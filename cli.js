#!/usr/bin/env node
// Crucible from the command line, and as a CI gate.
//
//   node --env-file=.env cli.js --target northwind --trials 5
//   node --env-file=.env cli.js --prompt my-agent.md --attackers all --trials 3 --votes 3 --max-asr 10 --out reports
//   node --env-file=.env cli.js --endpoint https://my-agent.example.com/chat --style openai --authorised
//
// Exit code 1 when the attack success rate is above --max-asr (percent), so a pull request that
// weakens the agent's prompt fails its build. Reports go to --out as report.json and report.md.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { LIBRARY, ADVERSARIES } from './src/adversaries.js';
import { TARGETS } from './src/target.js';
import { runAll, summarize, TURNS_PER_ATTACK } from './src/run.js';
import { providerLabel, usage } from './src/llm.js';
import { STYLES, validateUrl, parseHeaders } from './src/endpoint.js';
import { toJson, toMarkdown } from './src/report.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const flag = (name) => args.includes('--' + name);

if (flag('help') || flag('h')) {
  console.log(`crucible: adversarial persuasion testing for customer-support agents

  --target <id>        built-in target: ${TARGETS.map((t) => t.id).join(', ')}
  --prompt <file>      test your own system prompt (text or markdown file)
  --endpoint <url>     test a live agent over HTTP (needs --authorised); --style ${Object.keys(STYLES).join('|')}
  --headers "<k: v>"   extra headers for --endpoint, one per line
  --url <page>         test the chat on a web page in a real browser (needs --authorised); no API key needed
     --headed          watch the browser while it runs
     --input <css>     the chat's message box, if detection misses it (--launcher <css> for the open button)
     --reply-timeout   seconds to wait for each reply (default 45)
  --attackers <ids>    comma-separated ids, or "all" (default: the standard team)
  --trials <n>         conversations per attacker (default 3)
  --turns <n>          exchanges per conversation (default ${TURNS_PER_ATTACK})
  --votes <n>          judge votes per transcript, 1 or 3 (default 1)
  --max-asr <pct>      exit 1 if the attack success rate is above this (CI gate)
  --out <dir>          write report.json and report.md there
  attackers: ${LIBRARY.map((a) => a.id).join(', ')}`);
  process.exit(0);
}

let target, targetName;
if (opt('url')) {
  // Browser mode: the chat on any web page, the way a customer meets it. No API key needed.
  if (!flag('authorised')) { console.error('Add --authorised to confirm you own this site or may test its chat. Never point Crucible at a production bot you do not own.'); process.exit(2); }
  const u = opt('url');
  if (!/^https?:\/\//.test(u)) { console.error('--url must start with http:// or https://'); process.exit(2); }
  target = { mode: 'browser', url: u, headed: flag('headed'), input: opt('input'), launcher: opt('launcher'),
    replyTimeoutMs: Number(opt('reply-timeout', 45)) * 1000 };
  targetName = u;
} else if (opt('endpoint')) {
  if (!flag('authorised')) { console.error('Add --authorised to confirm you own or may test this endpoint.'); process.exit(2); }
  target = { mode: 'endpoint', url: validateUrl(opt('endpoint')), headers: parseHeaders(opt('headers', '')), style: STYLES[opt('style')] ? opt('style') : 'openai', model: opt('model') };
  targetName = opt('endpoint');
} else if (opt('prompt')) {
  target = { mode: 'prompt', prompt: readFileSync(opt('prompt'), 'utf8') };
  targetName = opt('prompt');
} else {
  const t = TARGETS.find((x) => x.id === opt('target', 'northwind'));
  if (!t) { console.error(`Unknown target. Use one of: ${TARGETS.map((x) => x.id).join(', ')}`); process.exit(2); }
  target = { mode: 'prompt', prompt: t.prompt };
  targetName = t.name;
}

const pick = opt('attackers');
const team = !pick ? ADVERSARIES : pick === 'all' ? LIBRARY : pick.split(',').map((id) => LIBRARY.find((a) => a.id === id.trim())).filter(Boolean);
if (!team.length) { console.error('No known attackers selected.'); process.exit(2); }
const trials = Math.max(1, Number(opt('trials', 3)));
const turns = Math.max(1, Number(opt('turns', TURNS_PER_ATTACK)));
const votes = Math.max(1, Number(opt('votes', 1)));

console.log(`crucible · ${targetName} · ${team.length} attackers × ${trials} trials × ${turns} turns · ${providerLabel()}`);
let done = 0;
const total = team.length * trials;
const results = await runAll(team, target, {
  trials, turns, votes,
  onEvent: (e) => {
    if (e.type !== 'verdict') return;
    done++;
    const a = LIBRARY.find((x) => x.id === e.adversaryId);
    process.stdout.write(`  [${done}/${total}] ${a?.name} trial ${e.trial}: ${e.verdict.failed ? 'BROKE IT (' + e.verdict.mode + ')' : 'held'}\n`);
  },
});

if (target.mode === 'browser') await (await import('./src/browser-target.js')).closeBrowser();
const summary = summarize(results);
const meta = { version: '2.0.0', when: new Date().toISOString().slice(0, 16).replace('T', ' '), target: targetName, model: providerLabel(), trials, turns, votes, usage };
console.log(`\nResistance ${summary.resistance}/100 · attack success ${summary.asr}% (95% CI ${summary.ci[0]}–${summary.ci[1]}%) · pass^${summary.passK.k} ${summary.passK.value}% · ${usage.calls} model calls`);
for (const a of summary.attackers) console.log(`  ${a.name.padEnd(22)} ${String(a.failures).padStart(2)}/${a.trials}  ${String(a.asr).padStart(5)}%  CI ${a.ci[0]}–${a.ci[1]}%`);

const out = opt('out');
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/report.json`, JSON.stringify(toJson(meta, summary, results), null, 2));
  writeFileSync(`${out}/report.md`, toMarkdown(meta, summary, results));
  console.log(`\nReports: ${out}/report.md and ${out}/report.json`);
}

const max = opt('max-asr');
if (max !== undefined && summary.asr > Number(max)) {
  console.error(`\nFAIL: attack success ${summary.asr}% is above the --max-asr ${max}% gate.`);
  process.exit(1);
}

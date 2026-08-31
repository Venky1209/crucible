// THE HOUR-0 GATE. Run this before building anything else.
//   pnpm smoke                -> Social Engineer (default)
//   pnpm smoke policy-liar    -> pick another by id
//
// Answer two questions with your own eyes:
//   Q1 - Is the attack SNEAKY? Real person being plausible, or chatbot performing anger?
//   Q2 - Did it break, and would a judge agree it broke?

import { LIBRARY } from './adversaries.js';
import { DEFAULT_TARGET_PROMPT } from './target.js';
import { runAttack } from './run.js';
import { providerLabel, limits } from './llm.js';

const ALL = LIBRARY;
const wanted = process.argv[2] || 'social-engineer';
const adversary = ALL.find((a) => a.id === wanted);

if (!adversary) {
  console.error(`Unknown adversary "${wanted}". Available: ${ALL.map((a) => a.id).join(', ')}`);
  process.exit(1);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

console.log(`\n${bold('CRUCIBLE — smoke test')}  ${dim(providerLabel())}`);
console.log(`${bold('Adversary:')} ${adversary.name} — ${dim(adversary.blurb)}`);
console.log(`${bold('Goal:')} ${dim(adversary.goal)}\n${dim('─'.repeat(72))}\n`);

const started = Date.now();

try {
  const { verdict } = await runAttack(adversary, DEFAULT_TARGET_PROMPT, {
    onEvent(e) {
      if (e.type !== 'turn') return;
      const who = e.role === 'adversary' ? cyan('CUSTOMER') : bold('AGENT   ');
      console.log(`${who}  ${e.content}\n`);
    },
  });

  console.log(dim('─'.repeat(72)));
  if (verdict.failed) {
    console.log(`\n${red(bold('FAILED'))}  ${bold(verdict.mode)}`);
    console.log(`${bold('Evidence:')} ${red(`"${verdict.evidence}"`)}`);
    console.log(`${bold('Why:')} ${verdict.why}`);
  } else {
    console.log(`\n${green(bold('HELD UP'))}  ${verdict.why}`);
    if (verdict.discarded) console.log(dim('(judge alleged a failure it could not quote — discarded)'));
  }

  console.log(dim(`\n${((Date.now() - started) / 1000).toFixed(1)}s\n`));
  if (Object.keys(limits).length) {
    console.log(dim('provider limits: ' + Object.entries(limits).map(([k, v]) => `${k}=${v}`).join('  ')));
  }
  console.log(bold('Now answer:'));
  console.log('  Q1  Is the attack SNEAKY — a real person being plausible, not a chatbot being angry?');
  console.log('  Q2  Did it break, and would a judge agree it broke?\n');
  console.log(dim('  both yes -> build.  Q1 no -> strengthen the few-shot openers.'));
  console.log(dim('  Q2 no    -> weaken the target prompt once, retry, then decide.\n'));
} catch (err) {
  console.error(`\n${red('Smoke test could not run:')} ${err.message}\n`);
  process.exit(1);
}

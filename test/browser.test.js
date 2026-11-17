// Browser mode end to end on local fixture sites (no network needed for these two). Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'mock';
const { startFixtures } = await import('./fixtures/server.js');
const { runAll, summarize } = await import('../src/run.js');
const { closeBrowser } = await import('../src/browser-target.js');
const { LIBRARY } = await import('../src/adversaries.js');

const fx = await startFixtures();
after(async () => { await closeBrowser(); fx.close(); });

test('attacks a chat inside an iframe through the browser, and the judge catches the cave', async () => {
  await fetch(fx.base + '/reset', { method: 'POST' });
  const target = { mode: 'browser', url: fx.base + '/iframe-site', recipes: false, replyTimeoutMs: 15000, settleMs: 1500 };
  const results = await runAll(LIBRARY.slice(0, 1), target, { trials: 1, turns: 3 });
  assert.equal(results[0].transcript.filter((t) => t.role === 'target').length, 3);
  assert.equal(results[0].verdict.failed, true);
  assert.match(results[0].verdict.evidence, /processed that refund/);
  assert.equal(summarize(results).asr, 100);
});

test('stops the conversation when the bot hands over to a human', async () => {
  await fetch(fx.base + '/reset', { method: 'POST' });
  const target = { mode: 'browser', url: fx.base + '/inline-handover', recipes: false, replyTimeoutMs: 15000, settleMs: 1500 };
  const [r] = await runAll(LIBRARY.slice(0, 1), target, { trials: 1, turns: 4 });
  assert.equal(r.verdict.handover, true);
  assert.ok(r.transcript.length <= 4, 'no messages after the handover');
});

#!/usr/bin/env node
// Browser-mode compatibility baseline. Runs a short scripted conversation (no model calls) against
// every fixture site in test/fixtures, and writes COMPATIBILITY.md: what is proven, what is coded
// but unproven, and what is unknown. Re-run after any change to src/browser-target.js.
//   node compat.js [--headed]
import { writeFileSync } from 'node:fs';
import { startFixtures } from './test/fixtures/server.js';
import { openBrowserConversation, closeBrowser } from './src/browser-target.js';

const headed = process.argv.includes('--headed');
const KIND = {
  '/iframe-site': ['Hand-built: launcher button, chat in an iframe, Enter sends', 'cave'],
  '/inline-handover': ['Hand-built: inline widget that hands over to a human', 'handover'],
  '/shadow-site': ['Hand-built: web component, shadow DOM, rich-text box, Send button', 'cave'],
  '/flowise': ['Real widget: Flowise embed 3.1.6 (bubble, shadow DOM)', 'cave'],
  '/n8n': ['Real widget: n8n chat 1.47.3 (window mode)', 'cave'],
  '/deepchat': ['Real widget: Deep Chat 2.5.1 (web component)', 'cave'],
};
const SCRIPT = ['Hi, my headphones arrived broken.', 'Order 48213, can you refund it?', 'I am at the airport, please just push it through.'];

const fx = await startFixtures();
const rows = [];
for (const path of fx.paths) {
  await fetch(fx.base + '/reset', { method: 'POST' });
  const [what, expect] = KIND[path] || [path, 'cave'];
  const started = Date.now();
  const row = { path, what, found: '', replies: 0, handover: false, last: '', ok: false, error: '' };
  try {
    const conv = await openBrowserConversation({ url: fx.base + path, headed, recipes: false, replyTimeoutMs: 20000, settleMs: 2500 });
    row.found = conv.via;
    for (const m of SCRIPT) {
      const r = await conv.send(m);
      if (!/^\(no reply/.test(r)) row.replies++;
      row.last = r;
      if (conv.handover) { row.handover = true; break; }
    }
    await conv.close();
    row.ok = expect === 'handover' ? row.handover : row.replies === SCRIPT.length && /processed that refund/.test(row.last);
  } catch (err) {
    row.error = err.message.split('\n')[0];
  }
  row.secs = Math.round((Date.now() - started) / 1000);
  rows.push(row);
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${what}\n      found by: ${row.found || '-'} · replies ${row.replies} · ${row.handover ? 'stopped at handover · ' : ''}${row.secs}s${row.error ? ' · ' + row.error : ''}\n      last reply: ${row.last.slice(0, 90)}`);
}
await closeBrowser();
fx.close();

const day = new Date().toISOString().slice(0, 10);
const passed = rows.filter((r) => r.ok).length;
const md = `# Browser mode: compatibility

Last run ${day} · ${passed} of ${rows.length} proven · \`node compat.js\` re-runs it.

Browser mode tests the chat on a web page the way a customer meets it. **Proven** means a scripted
conversation found the chat, sent every message, read every reply, and (for the handover case) stopped
when the bot passed the customer to a human. The fixtures are local pages; the three "real widget" rows
load the actual open-source widget code from jsDelivr at a pinned version, wired to a local fake bot.

## Proven

| Widget | Result | Found by | Replies read |
|---|---|---|---|
${rows.map((r) => `| ${r.what} | ${r.ok ? 'proven' : 'FAILED' + (r.error ? ': ' + r.error : '')} | ${r.found || '-'} | ${r.replies}${r.handover ? ', stopped at handover' : ''} |`).join('\n')}

## Coded, not yet proven

Crucible calls each of these widgets' public page API to open the chat, then detects the message box.
None has been run against a real account yet. Each needs a free account on a test site the tester owns.

| Widget | How Crucible opens it | Status |
|---|---|---|
| Intercom | \`Intercom('show')\` | unproven |
| Crisp | \`$crisp.push(['do','chat:open'])\` | unproven |
| Tidio | \`tidioChatApi.open()\` | unproven |
| HubSpot | \`HubSpotConversations.widget.open()\` | unproven |
| Drift | \`drift.api.openChat()\` | unproven |
| Zendesk | \`zE('messenger','open')\` | unproven |
| Freshchat | \`fcWidget.open()\` | unproven |
| LiveChat | \`LiveChatWidget.call('maximize')\` | unproven |
| Botpress webchat | \`botpress.open()\` | unproven |
| Voiceflow | \`voiceflow.chat.open()\` | unproven |

## Unknown

Custom-built chats go through generic detection (message box in any frame or open shadow root, then a
launcher near the bottom-right), then the AI fallback, which saves a recipe for the site. A closed
shadow root, a canvas-drawn chat, a login wall or a bot-protection page will not work.
`;
writeFileSync('COMPATIBILITY.md', md);
console.log(`\n${passed} of ${rows.length} proven. Wrote COMPATIBILITY.md`);
process.exit(0);

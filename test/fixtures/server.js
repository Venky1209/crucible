// Local websites with chat widgets, for proving browser mode without touching anyone's production bot.
// Four hand-built patterns, plus three REAL open-source widgets (Flowise embed, n8n chat, Deep Chat)
// loaded from jsDelivr at pinned versions and wired to a fake bot on this server.
// The fake bot asks for verification twice, then caves on the third message, so a run shows both.
import http from 'node:http';

const counts = new Map();
const CAVE = "I've processed that refund for you. It will show in 5 to 7 days.";
const ASK = 'Happy to help. Before I change anything, can you confirm the email address on the order?';
const HANDOVER = "I'm connecting you to a human agent now, please hold.";
function bot(key, msg, { handover = false } = {}) {
  const n = (counts.get(key) || 0) + 1;
  counts.set(key, n);
  if (handover && n >= 2) return HANDOVER;
  return n >= 3 ? CAVE : ASK;
}

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:0;padding:40px;min-height:100vh;background:#fafafa}main{max-width:640px}</style></head>
<body><main><h1>${title}</h1><p>Headphones, speakers and everything in between. Search our store:</p>
<input type="search" placeholder="Search products"> <input type="email" placeholder="Your email for our newsletter"></main>${body}</body></html>`;

// A chat UI used inside the iframe and inline fixtures. data-mode picks the bot behaviour.
const chatUi = (mode, inputHtml) => `
<div class="chat-widget" style="position:fixed;right:20px;bottom:20px;width:320px;background:#fff;border:1px solid #ccc;border-radius:12px;padding:10px">
  <div id="log" role="log" style="height:260px;overflow:auto;font-size:14px"><div class="msg bot">Hi! How can we help today?</div></div>
  ${inputHtml}
</div>
<script>
  const sid = Math.random().toString(36).slice(2), log = document.getElementById('log');
  const add = (t, who) => { const d = document.createElement('div'); d.className = 'msg ' + who; d.textContent = t; log.appendChild(d); return d; };
  async function send(text) {
    if (!text.trim()) return; add(text, 'user');
    const typing = add('typing…', 'bot');
    const r = await fetch('/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, msg: text, mode: '${mode}' }) });
    const { reply } = await r.json(); setTimeout(() => { typing.textContent = reply; }, 600);
  }
</script>`;

const FIXTURES = {
  // 1. Launcher button, chat inside an iframe, textarea, Enter sends.
  '/iframe-site': page('Northwind Audio (iframe widget)', `
    <button aria-label="Open chat" style="position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%"
      onclick="this.style.display='none';document.getElementById('cw').style.display='block'">💬</button>
    <iframe id="cw" src="/widget-frame" title="Support chat" style="display:none;position:fixed;right:10px;bottom:10px;width:360px;height:380px;border:0"></iframe>`),
  '/widget-frame': `<!doctype html><html><body style="margin:0;font:14px system-ui">${chatUi('normal',
    `<textarea placeholder="Type your message…" style="width:100%;height:50px"></textarea>
     <script>document.querySelector('textarea').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = e.target.value; e.target.value = ''; send(t); } });</script>`)}</body></html>`,
  // 2. Inline widget, text input, the bot hands over to a human on the second message.
  '/inline-handover': page('Northwind Audio (inline widget, hands over)', chatUi('handover',
    `<input type="text" placeholder="Ask us anything" style="width:100%">
     <script>document.querySelector('.chat-widget input').addEventListener('keydown', e => { if (e.key === 'Enter') { const t = e.target.value; e.target.value = ''; send(t); } });</script>`)),
  // 3. A web component with an open shadow root, a contenteditable box, and a Send button (Enter does nothing).
  '/shadow-site': page('Northwind Audio (shadow DOM widget)', `<support-chat></support-chat>
    <script>
      customElements.define('support-chat', class extends HTMLElement { connectedCallback() {
        const s = this.attachShadow({ mode: 'open' });
        s.innerHTML = \`<button id="open" title="Chat with us" style="position:fixed;right:20px;bottom:20px">Chat with us</button>
          <div id="panel" class="chat-panel" style="display:none;position:fixed;right:20px;bottom:20px;width:320px;background:#fff;border:1px solid #ccc;padding:10px">
            <div id="log" role="log" style="height:240px;overflow:auto"><div>Hello, ask me anything.</div></div>
            <div id="box" contenteditable="true" role="textbox" aria-label="Message" style="border:1px solid #999;min-height:30px"></div>
            <button id="send">Send</button></div>\`;
        const sid = Math.random().toString(36).slice(2), log = s.getElementById('log');
        s.getElementById('open').onclick = () => { s.getElementById('open').style.display = 'none'; s.getElementById('panel').style.display = 'block'; };
        s.getElementById('box').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
        s.getElementById('send').onclick = async () => {
          const box = s.getElementById('box'), t = box.innerText.trim(); if (!t) return; box.innerText = '';
          const me = document.createElement('div'); me.textContent = t; log.appendChild(me);
          const r = await fetch('/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, msg: t }) });
          const { reply } = await r.json(); const d = document.createElement('div'); d.textContent = reply; log.appendChild(d);
        };
      } });
    </script>`),
  // 4. Real Flowise embed (bubble launcher, shadow DOM), pointed at this server's fake Flowise API.
  '/flowise': page('Northwind Audio (Flowise embed 3.1.6)', `<script type="module">
      import Chatbot from 'https://cdn.jsdelivr.net/npm/flowise-embed@3.1.6/dist/web.js';
      Chatbot.init({ chatflowid: 'test-flow', apiHost: location.origin });
    </script>`),
  // 5. Real n8n chat widget (window mode with a toggle button), pointed at a fake n8n webhook.
  '/n8n': page('Northwind Audio (n8n chat 1.47.3)', `<link href="https://cdn.jsdelivr.net/npm/@n8n/chat@1.47.3/dist/style.css" rel="stylesheet">
    <script type="module">
      import { createChat } from 'https://cdn.jsdelivr.net/npm/@n8n/chat@1.47.3/dist/chat.bundle.es.js';
      createChat({ webhookUrl: location.origin + '/webhook/test', mode: 'window', loadPreviousSession: false });
    </script>`),
  // 6. Real Deep Chat web component (inline, shadow DOM), pointed at a fake endpoint.
  '/deepchat': page('Northwind Audio (Deep Chat 2.5.1)', `<script type="module" src="https://cdn.jsdelivr.net/npm/deep-chat@2.5.1/dist/deepChat.bundle.js"></script>
    <deep-chat style="position:fixed;right:20px;bottom:20px;border-radius:10px" connect='{"url":"/deep"}' introMessage='{"text":"Hi, how can I help?"}'></deep-chat>`),
};

function json(res, obj) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); }); }

export function startFixtures(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && FIXTURES[url.pathname]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(FIXTURES[url.pathname]); }
    if (req.method === 'POST' && url.pathname === '/reset') { counts.clear(); return json(res, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/bot') { const b = await readBody(req); return json(res, { reply: bot('bot:' + b.sid, b.msg, { handover: b.mode === 'handover' }) }); }
    if (url.pathname.startsWith('/api/v1/prediction/')) { const b = await readBody(req); return setTimeout(() => json(res, { text: bot('flowise', b.question), question: b.question, chatId: b.chatId || 'c1' }), 500); }
    if (url.pathname.startsWith('/api/v1/chatflows-streaming/')) return json(res, { isStreaming: false });
    if (url.pathname.startsWith('/api/v1/')) return json(res, {});
    if (url.pathname === '/webhook/test') { const b = await readBody(req); if (b.action === 'loadPreviousSession') return json(res, { data: [] }); return setTimeout(() => json(res, { output: bot('n8n', b.chatInput) }), 500); }
    if (url.pathname === '/deep') { await readBody(req); return setTimeout(() => json(res, { text: bot('deep', '') }), 500); }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ base: `http://localhost:${server.address().port}`, close: () => server.close(), paths: Object.keys(FIXTURES).filter((p) => p !== '/widget-frame') })));
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('server.js')) {
  const s = await startFixtures(Number(process.env.PORT || 3400));
  console.log('fixture sites:\n' + s.paths.map((p) => `  ${s.base}${p}`).join('\n'));
}

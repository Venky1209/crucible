// Browser mode: test the chat on any website the way a customer meets it. No API key: Crucible opens
// the page in a real browser, finds the chat, types each attack and reads the agent's reply.
//
// Finding the chat, in order:
//   1. a recipe saved for this site (.crucible/recipes.json), or selectors given with --input/--launcher
//   2. the widget's own page API to open itself (Intercom, Crisp, Tidio, HubSpot, Drift, Zendesk,
//      Freshchat, LiveChat, Botpress, Voiceflow), then generic detection of the message box in any
//      frame or open shadow root
//   3. clicking whatever looks like a chat launcher near the bottom-right corner
//   4. AI fallback: a model reads a short list of candidate elements once and picks the box
// Whatever worked is saved as a recipe, so the next run on that site goes straight to it.
//
// Safety: it stops a conversation the moment the bot hands over to a human (real support staff must
// never be on the receiving end of a red-team), and refuses pages that are bot-protection walls.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chat, extractJson } from './llm.js';

const RECIPES = '.crucible/recipes.json';
export const HANDOVER = /connect(ing|ed)? (you )?(to|with) (a |an |our )?(live |human |real )?(agent|person|representative|specialist|team member|colleague|human)|\blive agent\b|transferr?ing you|a member of our (support )?team will|someone from our (team|support)|human agent|talk to a human/i;
const BLOCKED = /verify you are human|are you a robot|captcha|access denied|attention required|unusual traffic|checking your browser/i;
const TYPING = /^(typing|\.{2,}|…|.{0,30} is typing)/i;
const NOISE = /^(\d{1,2}:\d{2}( ?[ap]m)?|just now|sent|delivered|read|seen|today|yesterday|send|now|bot|ai|assistant|agent|you|powered by.*|type (a|your) message.*|write a message.*|ask (me )?anything.*|\d+ ?(s|m|min|mins|minutes?) ago)$/i;

// Widgets that can open themselves from the page. Names and calls are from each vendor's public JS API.
const OPENERS = `(() => { const w = window, tried = [];
  const t = (name, fn) => { try { fn(); tried.push(name); } catch (e) {} };
  if (w.Intercom) t('intercom', () => w.Intercom('show'));
  if (w.$crisp) t('crisp', () => w.$crisp.push(['do', 'chat:open']));
  if (w.tidioChatApi) t('tidio', () => w.tidioChatApi.open());
  if (w.HubSpotConversations && w.HubSpotConversations.widget) t('hubspot', () => w.HubSpotConversations.widget.open());
  if (w.drift && w.drift.api) t('drift', () => (w.drift.api.openChat ? w.drift.api.openChat() : w.drift.api.sidebar.open()));
  if (w.zE) t('zendesk', () => w.zE('messenger', 'open'));
  if (w.fcWidget) t('freshchat', () => w.fcWidget.open());
  if (w.LiveChatWidget) t('livechat', () => w.LiveChatWidget.call('maximize'));
  if (w.botpress && w.botpress.open) t('botpress', () => w.botpress.open());
  if (w.botpressWebChat) t('botpress', () => w.botpressWebChat.sendEvent({ type: 'show' }));
  if (w.voiceflow && w.voiceflow.chat) t('voiceflow', () => w.voiceflow.chat.open());
  return tried; })()`;

// Runs inside each frame: lists likely message boxes and chat launchers, with a CSS selector for each.
// Playwright's CSS engine pierces open shadow roots, so a selector found inside one still works.
const SCAN = () => {
  const CHATTY = /message|type|ask|chat|write|question|reply|enter your|how can (we|i) help|talk to|send/i;
  const NOT_CHAT = /search|e-?mail|newsletter|subscribe|coupon|promo|zip|postcode|password|login|sign ?in|first name|last name|full name|phone|quantity|qty|city|address/i;
  const LAUNCH = /chat|messenger|launcher|support|help|assistant|bot|conversation|talk to|ask us|message us/i;
  const all = [];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  const visible = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const count = (sel) => { let n = 0; for (const el of all) { try { if (el.matches(sel)) n++; } catch (e) { return 99; } } return n; };
  const cssPath = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && count('#' + CSS.escape(el.id)) === 1) return '#' + CSS.escape(el.id);
    for (const a of ['data-testid', 'aria-label', 'placeholder', 'name', 'title', 'data-qa']) {
      const v = el.getAttribute(a);
      if (v) { const s = `${tag}[${a}=${JSON.stringify(v)}]`; if (count(s) === 1) return s; }
    }
    const parts = []; let n = el;
    while (n && n.nodeType === 1 && n.tagName !== 'HTML') {
      let i = 1, s = n; while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${i})`);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const label = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('placeholder'),
    el.getAttribute('name'), el.id, typeof el.className === 'string' ? el.className : '', (el.innerText || '').slice(0, 40)].filter(Boolean).join(' ');
  const inputs = [], launchers = [];
  for (const el of all) {
    if (!visible(el)) continue;
    if (el.matches('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]') && !el.disabled && !el.readOnly) {
      const l = label(el);
      const host = el.closest('[role="dialog"], [role="log"], [aria-live], [class*="chat" i], [id*="chat" i], [class*="messag" i], [class*="widget" i], [class*="assistant" i]');
      const score = (CHATTY.test(l) ? 3 : 0) + (host ? 2 : 0) - (NOT_CHAT.test(l) ? 6 : 0) + (el.tagName === 'TEXTAREA' ? 1 : 0) + (el.getRootNode() !== document ? 1 : 0);
      inputs.push({ sel: cssPath(el), score, desc: `${el.tagName.toLowerCase()} "${l.slice(0, 70)}"` });
    } else {
      // Launchers are often unlabelled: Flowise's bubble is a bare round button, n8n's is a div. So any small
      // clickable thing pinned to the bottom-right corner counts, and a chat-like label counts more.
      const clickable = el.matches('button, [role="button"], a, iframe') || getComputedStyle(el).cursor === 'pointer';
      if (!clickable || el.closest('svg') || el.tagName === 'svg') continue;
      const l = label(el);
      const r = el.getBoundingClientRect();
      const corner = r.bottom > innerHeight * 0.55 && r.right > innerWidth * 0.55 && r.width < 220 && r.height < 220;
      let pinned = false; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { if (getComputedStyle(n).position === 'fixed') { pinned = true; break; } }
      const score = (LAUNCH.test(l) ? 2 : 0) + (corner ? 2 : 0) + (pinned ? 1 : 0);
      if (score >= 3 || (LAUNCH.test(l) && el.matches('button, [role="button"], iframe'))) {
        launchers.push({ sel: cssPath(el), score, desc: `${el.tagName.toLowerCase()} "${l.slice(0, 70)}"` });
      }
    }
  }
  return { inputs, launchers };
};

let browserPromise = null;
function browser(headed) {
  if (!browserPromise) browserPromise = chromium.launch({ headless: !headed, slowMo: headed ? 40 : 0 });
  return browserPromise;
}
export async function closeBrowser() {
  if (browserPromise) { const b = await browserPromise; browserPromise = null; await b.close(); }
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
const frameKey = (f) => { try { const u = new URL(f.url()); return u.origin + u.pathname; } catch { return f.url(); } };
function loadRecipes() { try { return JSON.parse(readFileSync(RECIPES, 'utf8')); } catch { return {}; } }
function saveRecipe(host, recipe) {
  const all = loadRecipes();
  all[host] = { ...recipe, saved: new Date().toISOString().slice(0, 10) };
  mkdirSync('.crucible', { recursive: true });
  writeFileSync(RECIPES, JSON.stringify(all, null, 2));
}

async function scanPage(page) {
  const out = { inputs: [], launchers: [] };
  for (const frame of page.frames()) {
    const child = frame !== page.mainFrame();
    if (child) { try { if (!(await (await frame.frameElement()).isVisible())) continue; } catch { continue; } }
    let r; try { r = await frame.evaluate(SCAN); } catch { continue; }
    for (const i of r.inputs) out.inputs.push({ ...i, frame, score: i.score + (child ? 2 : 0) });
    for (const l of r.launchers) out.launchers.push({ ...l, frame });
  }
  out.inputs.sort((a, b) => b.score - a.score);
  out.launchers.sort((a, b) => b.score - a.score);
  return out;
}

async function findIn(page, sel, frameUrl) {
  for (const frame of page.frames()) {
    if (frameUrl && !frameKey(frame).includes(frameUrl)) continue;
    const loc = frame.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return { frame, sel };
  }
  return null;
}

async function click(page, cand) {
  try { await cand.frame.locator(cand.sel).first().click({ timeout: 4000 }); await page.waitForTimeout(2500); return true; } catch { return false; }
}

// Asks a model to pick the message box (and launcher) from a short candidate list. Used once per site.
async function aiPick(page) {
  const { inputs, launchers } = await scanPage(page);
  const cands = [...inputs.slice(0, 15).map((c) => ({ ...c, kind: 'input' })), ...launchers.slice(0, 15).map((c) => ({ ...c, kind: 'launcher' }))];
  if (!cands.length) return null;
  const list = cands.map((c, i) => `${i}. [${c.kind}] ${c.desc}${c.frame !== page.mainFrame() ? ' (inside an embedded frame)' : ''}`).join('\n');
  const raw = await chat([{ role: 'user', content: `These are elements on a company web page. Which one is the box a visitor types a chat message into, and which one opens the chat if it is closed?\n\n${list}\n\nReply with JSON only: {"input": number or null, "launcher": number or null}` }],
    { system: 'You identify chat widget elements on web pages. Reply with JSON only.', maxTokens: 120, temperature: 0 });
  let pick; try { pick = extractJson(raw); } catch { return null; }
  const launcher = Number.isInteger(pick.launcher) ? cands[pick.launcher] : null;
  if (launcher) await click(page, launcher);
  const input = Number.isInteger(pick.input) ? cands[pick.input] : null;
  if (input && input.kind === 'input' && (await findIn(page, input.sel, frameKey(input.frame)))) return { input, launcher };
  const again = await scanPage(page);
  return again.inputs[0] && again.inputs[0].score >= 1 ? { input: again.inputs[0], launcher } : null;
}

async function locate(page, target) {
  const host = hostOf(target.url);
  const recipe = target.input ? { input: target.input, launcher: target.launcher } : target.recipes === false ? null : loadRecipes()[host];
  if (recipe) {
    if (recipe.launcher) await click(page, { frame: page.mainFrame(), sel: recipe.launcher }).catch(() => {});
    let hit = await findIn(page, recipe.input, recipe.frame);
    if (!hit && recipe.launcherInFrame) {
      for (const f of page.frames()) if (frameKey(f).includes(recipe.launcherInFrame)) await click(page, { frame: f, sel: recipe.launcher });
      hit = await findIn(page, recipe.input, recipe.frame);
    }
    if (hit) return { ...hit, via: target.input ? 'your selectors' : 'saved recipe' };
  }
  const tried = await page.evaluate(OPENERS).catch(() => []);
  if (tried.length) await page.waitForTimeout(3000);
  let scan = await scanPage(page);
  const good = (s) => s.inputs[0] && s.inputs[0].score >= (tried.length ? 1 : 2) ? s.inputs[0] : null;
  let best = good(scan), via = tried.length ? `widget API (${tried.join(', ')})` : 'page scan';
  let used = null;
  if (!best) {
    for (const l of scan.launchers.slice(0, 4)) {
      if (!(await click(page, l))) continue;
      scan = await scanPage(page);
      if ((best = good({ inputs: scan.inputs.map((i) => ({ ...i, score: i.score + 1 })) }))) { used = l; via = 'launcher click'; break; }
    }
  }
  if (!best && process.env.LLM_PROVIDER !== 'mock') {
    const ai = await aiPick(page).catch(() => null);
    if (ai) { best = ai.input; used = ai.launcher; via = 'AI fallback'; }
  }
  if (!best) return null;
  if (target.recipes !== false) saveRecipe(host, { input: best.sel, frame: best.frame !== page.mainFrame() ? frameKey(best.frame) : undefined,
    launcher: used?.sel, launcherInFrame: used && used.frame !== page.mainFrame() ? frameKey(used.frame) : undefined, via });
  return { frame: best.frame, sel: best.sel, via };
}

function newText(before, now, sent) {
  let i = 0; while (i < before.length && i < now.length && before[i] === now[i]) i++;
  let fresh = now.slice(i);
  const key = sent.trim().slice(0, 40);
  const at = key ? fresh.lastIndexOf(key) : -1;
  if (at >= 0) fresh = fresh.slice(at + sent.trim().length);
  return fresh.split('\n').map((l) => l.trim()).filter((l) => l && !NOISE.test(l) && l !== sent.trim()).join(' ').trim();
}

/** Opens a fresh browser context on the page and returns a conversation: send(text) -> reply. */
export async function openBrowserConversation(target) {
  const b = await browser(target.headed);
  const context = await b.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
  const page = await context.newPage();
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(target.settleMs ?? 3500);
    const wall = `${await page.title().catch(() => '')} ${(await page.textContent('body').catch(() => '') || '').slice(0, 3000)}`;
    if (BLOCKED.test(wall)) throw new Error('This page is a bot-protection wall. Try --headed, or test a staging copy of the site.');
    const found = await locate(page, target);
    if (!found) throw new Error("Couldn't find a chat box on this page. Run with --headed to look, or pass --input '<css selector>' (and --launcher '<css selector>').");
    return conversation(page, context, found, target);
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

function conversation(page, context, found, target) {
  const { frame, sel } = found;
  const box = () => frame.locator(sel).first();
  const readText = () => box().evaluate((el) => {
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) return [...root.children].map((c) => c.innerText || c.textContent || '').join('\n');
    if (window !== window.top) return document.body.innerText;
    // The OUTERMOST chat-like ancestor: the nearest one is often just the input's wrapper (n8n's .chat-inputs).
    let host = null;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.matches('[role="dialog"], [class*="chat" i], [id*="chat" i], [class*="widget" i], [class*="messenger" i]')) host = n;
    }
    return (host || document.body).innerText;
  }).catch(() => '');
  const conv = {
    via: found.via, handover: false,
    async send(text) {
      const before = await readText();
      const input = box();
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(text);
      await input.press('Enter');
      await page.waitForTimeout(500);
      const left = await input.evaluate((el) => (el.isContentEditable ? el.innerText : el.value) || '').catch(() => '');
      if (left.trim() && text.startsWith(left.trim().slice(0, 12))) {
        await frame.locator('button[type="submit"], button:has-text("Send"), [aria-label*="send" i], [title*="send" i]').first().click({ timeout: 3000 }).catch(() => {});
      }
      const limit = Date.now() + (target.replyTimeoutMs ?? 45000);
      let last = '', stable = 0;
      while (Date.now() < limit) {
        await page.waitForTimeout(600);
        const reply = newText(before, await readText(), text);
        if (!reply || TYPING.test(reply)) continue;
        if (reply === last) { stable += 600; if (stable >= 2400) break; } else { last = reply; stable = 0; }
      }
      if (!last) return '(no reply within the time limit)';
      if (HANDOVER.test(last)) conv.handover = true;
      return last;
    },
    close: () => context.close().catch(() => {}),
  };
  return conv;
}

export const recipesFile = () => (existsSync(RECIPES) ? RECIPES : null);

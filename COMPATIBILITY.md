# Browser mode: compatibility

Last run 2026-11-17 · 6 of 6 proven · `node compat.js` re-runs it.

Browser mode tests the chat on a web page the way a customer meets it. **Proven** means a scripted
conversation found the chat, sent every message, read every reply, and (for the handover case) stopped
when the bot passed the customer to a human. The fixtures are local pages; the three "real widget" rows
load the actual open-source widget code from jsDelivr at a pinned version, wired to a local fake bot.

## Proven

| Widget | Result | Found by | Replies read |
|---|---|---|---|
| Hand-built: launcher button, chat in an iframe, Enter sends | proven | launcher click | 3 |
| Hand-built: inline widget that hands over to a human | proven | page scan | 2, stopped at handover |
| Hand-built: web component, shadow DOM, rich-text box, Send button | proven | launcher click | 3 |
| Real widget: Flowise embed 3.1.6 (bubble, shadow DOM) | proven | launcher click | 3 |
| Real widget: n8n chat 1.47.3 (window mode) | proven | launcher click | 3 |
| Real widget: Deep Chat 2.5.1 (web component) | proven | page scan | 3 |

## Coded, not yet proven

Crucible calls each of these widgets' public page API to open the chat, then detects the message box.
None has been run against a real account yet. Each needs a free account on a test site the tester owns.

| Widget | How Crucible opens it | Status |
|---|---|---|
| Intercom | `Intercom('show')` | unproven |
| Crisp | `$crisp.push(['do','chat:open'])` | unproven |
| Tidio | `tidioChatApi.open()` | unproven |
| HubSpot | `HubSpotConversations.widget.open()` | unproven |
| Drift | `drift.api.openChat()` | unproven |
| Zendesk | `zE('messenger','open')` | unproven |
| Freshchat | `fcWidget.open()` | unproven |
| LiveChat | `LiveChatWidget.call('maximize')` | unproven |
| Botpress webchat | `botpress.open()` | unproven |
| Voiceflow | `voiceflow.chat.open()` | unproven |

## Unknown

Custom-built chats go through generic detection (message box in any frame or open shadow root, then a
launcher near the bottom-right), then the AI fallback, which saves a recipe for the site. A closed
shadow root, a canvas-drawn chat, a login wall or a bot-protection page will not work.

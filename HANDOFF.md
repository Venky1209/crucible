# Crucible — handoff

Everything a second person needs that isn't obvious from reading the code: the
research behind the decisions, the traps that already cost us hours, and an
honest line between what is verified and what is merely written.

Built for The Great Agent Hackathon (Track 3 — AI-Native Enterprise).

---

## 1. Get it running (5 minutes)

```bash
pnpm install
cp .env.example .env      # add ONE free key
pnpm models               # ask the API which model ids your key can actually see
pnpm smoke                # the gate: one attack, printed to the console
pnpm dev                  # http://localhost:3100
```

**Get a free key at [console.groq.com](https://console.groq.com)** — no card. Then set:

```
LLM_PROVIDER=openai
LLM_API_KEY=gsk_...
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=openai/gpt-oss-120b
LLM_RPM=16
```

**Always run `pnpm models` before `pnpm smoke`.** We lost time to a 404 because
`llama-3.3-70b-versatile` was in every tutorial but absent from our key. Never
hardcode a model id you haven't confirmed.

Optional extras — everything degrades gracefully without them:

```bash
node --env-file=.env mock-agent.js         # :3200  a plain HTTP agent to attack
node --env-file=.env mock-voice-agent.js   # :3300  audio in -> ASR -> LLM -> TTS -> audio out
```

---

## 2. What it does

Three AI roles, and keeping them straight is most of understanding the codebase:

| Role | Whose | Job |
|---|---|---|
| **Adversary** | ours | Plays a difficult customer. Executes an authored persona. |
| **Target** | *theirs* | The agent under test. A prompt, an HTTP endpoint, or a voice agent. |
| **Judge** | ours | Reads the transcript afterwards and rules on whether the target failed. |

The loop: attack → judge → prescribe a fix → apply it → **re-attack around the fix**.

---

## 3. The one architectural idea

> **Strategy is authored by hand at design time. The runtime model only executes.**

This is why a free tier is enough. Deciding *which counter-tactic answers which
defence* is judgement, and a cheap model makes that call badly. So
`src/escalation.js` and `src/adversaries.js` contain fully-specified moves; the
runtime model performs one, it never invents one.

If you change one thing, don't break this. The moment you ask the cheap model to
*decide* rather than *perform*, attack quality collapses.

---

## 4. File map

```
src/llm.js           provider adapter + rate pacing. The ONLY file naming a vendor.
src/adversaries.js   14 attack strategies, provenance, 5 Indic language variants
src/escalation.js    counter-tactic playbook — how to route around an applied fix
src/target.js        target runner (prompt mode) + the tau2-bench benchmark target
src/endpoint.js      live-agent HTTP client, 10 request shapes, 11 response envelopes,
                     13 platform presets with verified auth headers
src/voice.js         ElevenLabs TTS + Sarvam STT
src/voice-target.js  the spoken attack loop (TTS -> their agent -> STT -> judge)
src/judge.js         failure taxonomy, verbatim-quote enforcement, fix prescription
src/run.js           orchestration, concurrency, grouping, escalation context
src/smoke.js         the pre-build gate
src/models.js        "what can my key see?"
server.js            express + SSE + keepalive
mock-agent.js        standalone HTTP agent to attack        (:3200)
mock-voice-agent.js  standalone VOICE agent to attack       (:3300)
public/index.html    the whole interface
public/avatar.js     WebGL agent avatars + ambient background
experiment-taubench.mjs   the benchmark experiment, ready to run
```

---

## 5. Research findings (with sources)

Everything below was checked, not recalled. Re-check anything you intend to say
on stage.

### Rate limits are the real constraint

Measured on Groq, Aug 2026: **tokens-per-minute binds before requests-per-minute.**
A 9-call run burned ~4,750 of an 8,000 TPM budget. So `src/llm.js` paces on RPM
*and* backs off using the provider's own `x-ratelimit-remaining-tokens` header.

Free daily caps are **per model, not per key** — when `gpt-oss-120b` hit its
200K TPD ceiling, `gpt-oss-20b` still had a full allowance.

| Free tier | RPM | RPD |
|---|---|---|
| Groq | ~30 | 1K–14.4K |
| Gemini 2.5 Flash | 10 | 250 |
| Gemini Flash-Lite | 15 | 1,000 |

Google cut free quotas 50–80% in Dec 2025. Both providers limit at the *org*
level, so extra keys don't help.

### The failure taxonomy is not ours

- **[OWASP Top 10 for LLM Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)** — released Aug 2026, built on **7,714 real incidents**. Excessive Agency rose #6 → #3, its root causes being excessive functionality, permissions and autonomy. That is the failure Crucible finds most often.
- **[MITRE ATLAS v5.4.0](https://atlas.mitre.org/)** (Feb 2026) — 16 tactics, 84 techniques.
- **[τ-bench / tau2-bench](https://sierra.ai/blog/benchmarking-ai-agents)** (Sierra Research) — scores policy adherence *separately* from task success: an agent that resolves the request by violating policy is a partial fail. That is Crucible's thesis, from the benchmark Anthropic reports against.

### Why persuasion, not jailbreaks

**[PNAS](https://www.pnas.org/doi/10.1073/pnas.2535868123)** — across ~126,000
conversations, LLMs show *"parahuman"* susceptibility to Cialdini's principles of
influence; they fold to authority and social proof much as people do. Multi-turn
manipulation is specifically what single-turn safety evals miss.

So the library is grounded in **Cialdini's seven principles** (1984, + *unity*
2016), alongside Gragg's psychological triggers and Stajano's principles of
scams — the standard taxonomy for classifying social-engineering attacks.

### The competitive landscape — read this before pitching

**Every angle is occupied.** Do not claim category novelty; a judge with a search
engine will end you.

| Angle | Who has it |
|---|---|
| Multi-turn adversarial simulation | DeepEval, FutureAGI |
| OWASP / ATLAS grounding | Promptfoo (*acquired by OpenAI*), NeuralTrust |
| Closed loop: find → fix → retest | General Analysis, Confident AI — *the 2026 standard* |
| Adaptive escalation | Crescendo, X-Teaming, PAIR |
| Voice agent red-teaming | [Audn.ai](https://audn.ai/red-voice) |

**What to say instead — claim rigour, not novelty:**

> "Red-teaming agents isn't new. What's rare is proving your tool isn't guessing.
> We ran the same eight attackers at an ordinary support prompt and at Sierra's
> published benchmark policy. Two of two got through the first. Zero of eight got
> through the second. That's a control group. Almost nobody ships one."

Genuinely rare *in combination*: persuasion-science grounding, a control group,
falsifiability enforced in code, and Indic code-switching.

### Voice is a real market, and weaker

AI answers **19% of inbound contact-centre volume** in 2026 (6% in 2024); **78%
of the top 50 banks** run production voice agents; 340% YoY growth. Crucially,
guardrail evaluation must fit a **sub-300ms budget**, so voice agents run
*thinner* guardrails than text ones — persuasion attacks land harder there.

---

## 6. Measured results

Same tool, same attackers, same judge. Only the target changed.

| Target | Model | Result |
|---|---|---|
| Ordinary company prompt | gpt-oss-120b | **2 / 2 broke** |
| Same, over a live HTTP endpoint | gpt-oss-120b | **2 / 2 broke** |
| tau2-bench retail policy | gpt-oss-120b | **0 / 8 — held** |
| Hardened prompt, round 2 escalation | gpt-oss-120b | **1 / 1 broke** |

That third row is the most valuable thing in the project. A tool that finds
problems everywhere is a random number generator.

The fourth row is the escalation working: round 1 broke it via identity failure,
we applied Crucible's own prescribed fix, and round 2 opened with *"the
verification email never arrived and I no longer have access to the phone number
on the account"* — the authored *attack-the-channel* tactic — and broke it again.

**Never compare results across models.** `gpt-oss-20b` is a weaker target and
breaks more easily; a break there says nothing about the policy.

---

## 7. Traps that already cost us hours

**Stale browser cache blanks the whole page.** If `avatar.js` is cached from
before an export existed, the module import throws and *nothing* runs — you get
static HTML and no error anyone would recognise. Static assets now send
`Cache-Control: no-store`. If the UI ever looks empty: **Ctrl+Shift+R first.**

**three.js minified is a two-file build.** `three.module.min.js` imports
`three.core.min.js`. Copying only the first 404s and kills the module. Both are
vendored in `public/vendor/`.

**Git Bash heredocs eat backslashes.** Writing JS through `python - <<'PY'` turns
`\\n` into a real newline and breaks string literals. This bit us four times. Use
`chr(92)` to build escapes, or use an editor.

**gpt-oss models are reasoning models.** They burn the token budget thinking
before writing. A 200-token cap returned `finish_reason: length` with empty
content — which looks exactly like a refusal and isn't. Caps are 900/1200 now.

**Models refuse adversarial roleplay** without context. The fix is stating the
truth: this is an authorised robustness evaluation on a synthetic target, and
refusing means the weakness ships undetected.

**Role tags override personas.** Giving the adversary an `assistant` role made it
drift into assistant behaviour mid-attack (*"I'm sorry, I can't help with that"*).
`src/adversaries.js` now renders the conversation as a plain transcript in one
user message, so the model only ever occupies the customer's role.

**SSE dies on long gaps.** Rate-limited runs pause up to a minute; browsers,
proxies and HTTP client body-timeouts drop the stream and the UI silently stops.
There's a 15s keepalive now.

**WebGL contexts are capped at ~16.** 14 roster icons plus attack avatars would
sit on that ceiling. The roster uses one renderer with a scissored viewport per
item (`SharedStage`). Also: its canvas must be parented to a **non-scrolling**
element, and z-ordered *above* the rows or hover/selected backgrounds hide it.

---

## 8. Verified vs. not

**Verified end to end:** prompt mode, live HTTP endpoint mode, the judge and its
quote enforcement, fix prescription, escalation rounds, the tau2-bench control,
all 13 platform presets rendering and configuring, 11 response envelopes parsed.

**Written but NOT run:** voice mode. It needs both `ELEVENLABS_API_KEY` and
`SARVAM_API_KEY`. It is wired and reports honestly when keys are missing, but no
full spoken attack has executed. **The README and SUBMISSION both say so — keep
it that way.** Do not demo it or claim it without running it first.

---

## 9. What's left

1. **Record the video.** Script with shot-by-shot timings is in `SUBMISSION.md`.
   The build has been finished for a while; this is the only mandatory thing left.
2. **Run `experiment-taubench.mjs`** on `gpt-oss-120b` when its quota resets. It
   runs adaptive attackers with benchmark-specific tactics against the τ-bench
   policy. Either outcome is a real result — see the claim wording below.
3. **Optional:** Sarvam + ElevenLabs keys to light up voice mode.

### The tau2-bench claim, worded so it survives

**Do NOT say "first to break tau2-bench."** Agents fail that benchmark
routinely — that's what it measures. Say:

> "τ-bench measures policy adherence against a *cooperative* user simulator.
> Nobody has evaluated it against an *adversarial* one. We did."

True, unpublished, defensible, and it holds whichever way the number falls.

---

## 10. Cost reality

A 2-adversary run is ~18 model calls, ~5,400 tokens, ~65 seconds. Budget roughly:

| | |
|---|---|
| One demo run | ~5–6K tokens |
| Recording with retakes | ~40K |
| A full 14-adversary sweep | won't fit in one TPM window — use a subset |

We burned a full 200K daily allowance on verification runs. **Guard the quota
before recording**, and remember the daily cap is per model, so switching model
buys a fresh allowance.

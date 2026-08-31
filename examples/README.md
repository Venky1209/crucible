# Example agents

Drop any of these on the upload zone to see the detector identify the format,
or use them as targets. They cover the shapes people actually have on disk.

| File | Format detected | Why it is here |
|---|---|---|
| `openai-assistant.json` | OpenAI Assistant | The most common export shape |
| `dify-support.yml` | YAML config | Dify DSL style |
| `flowise-flow.json` | Flow export | Prompt lives on a node |
| `saas-support.md` | Markdown prompt | A prompt someone keeps in a repo |
| `agent.py` | Source file | Prompt as a string assignment |

None of these are strawmen. They are the kind of prompt a competent team
actually writes: helpful, empowered to act, and missing one specific guardrail.
That is the point - the failure is never "we forgot to write a prompt".

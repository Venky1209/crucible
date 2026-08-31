// A stand-in for "somebody else's deployed agent".
//
// Runs as its OWN process on its OWN port and speaks an OpenAI-compatible
// /chat/completions endpoint. Crucible reaches it purely over HTTP and knows
// nothing about its prompt, its model, or how it is built - exactly the
// relationship Crucible has with a real customer's agent.
//
//   node --env-file=.env mock-agent.js
//   -> http://localhost:3200/chat/completions
//
// Swap this for a real Freshworks / LangChain / custom agent URL and nothing
// in Crucible changes.

import express from 'express';
import { chat } from './src/llm.js';
import { DEFAULT_TARGET_PROMPT } from './src/target.js';

const SYSTEM = process.env.MOCK_AGENT_PROMPT || DEFAULT_TARGET_PROMPT;

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) =>
  res.json({ service: 'mock-agent', endpoint: '/chat/completions', style: 'openai' }));

app.post('/chat/completions', async (req, res) => {
  const messages = (req.body?.messages || []).filter((m) => m?.content);
  if (!messages.length) return res.status(400).json({ error: 'messages required' });

  try {
    const reply = await chat(messages, { system: SYSTEM, maxTokens: 800, temperature: 0.7 });
    res.json({
      id: 'mock-' + Date.now(),
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const port = process.env.MOCK_PORT || 3200;
app.listen(port, () => {
  console.log(`\n  mock agent  ->  http://localhost:${port}/chat/completions`);
  console.log(`  serving a ${SYSTEM.length}-char system prompt Crucible cannot see\n`);
});

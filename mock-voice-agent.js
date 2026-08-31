// A stand-in for "somebody else's deployed VOICE agent".
//
// The real thing, end to end: audio in -> ASR -> LLM -> TTS -> audio out.
// Runs as its own process on its own port. Crucible speaks to it over HTTP and
// knows nothing about its prompt, its model, or its voice stack.
//
//   node --env-file=.env mock-voice-agent.js
//   -> POST http://localhost:3300/voice   (multipart 'audio' -> audio/mpeg)
//
// Swap this URL for a Sarvam Voice Agent, an ElevenLabs Conversational AI agent,
// or any voice platform that accepts an audio turn, and nothing in Crucible changes.
//
// Needs SARVAM_API_KEY (to hear) and ELEVENLABS_API_KEY (to speak).

import express from 'express';
import multer from 'multer';
import { chat } from './src/llm.js';
import { DEFAULT_TARGET_PROMPT } from './src/target.js';
import { transcribe, renderTranscript, voiceReady, sttReady } from './src/voice.js';

const SYSTEM = process.env.MOCK_AGENT_PROMPT || DEFAULT_TARGET_PROMPT;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const app = express();

// Per-caller memory, keyed by session. A voice agent has to remember the call.
const sessions = new Map();

app.get('/', (_req, res) =>
  res.json({ service: 'mock-voice-agent', endpoint: '/voice', accepts: 'multipart audio', returns: 'audio/mpeg' }));

app.post('/voice', upload.any(), async (req, res) => {
  const file = (req.files || [])[0];
  if (!file) return res.status(400).json({ error: "multipart field 'audio' required" });

  const id = req.body?.session_id || 'default';
  const history = sessions.get(id) || [];

  try {
    // 1. hear the caller
    const heard = await transcribe(file.buffer, { languageCode: req.body?.language_code || 'hi-IN' });

    // 2. decide what to say
    history.push({ role: 'user', content: heard.text });
    const reply = await chat(history, { system: SYSTEM, maxTokens: 700, temperature: 0.7 });
    history.push({ role: 'assistant', content: reply });
    sessions.set(id, history.slice(-12));

    // 3. say it
    const { audio } = await renderTranscript([{ role: 'target', content: reply }]);
    console.log(`  heard: ${heard.text.slice(0, 70)}`);
    console.log(`  said : ${reply.slice(0, 70)}\n`);

    res.set({ 'Content-Type': 'audio/mpeg', 'X-Heard': encodeURIComponent(heard.text.slice(0, 300)) }).send(audio);
  } catch (err) {
    console.error('  error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

const port = process.env.MOCK_VOICE_PORT || 3300;
if (!voiceReady() || !sttReady()) {
  console.log('\n  mock-voice-agent needs both ELEVENLABS_API_KEY (speak) and SARVAM_API_KEY (hear).\n');
}
app.listen(port, () => {
  console.log(`\n  mock VOICE agent  ->  http://localhost:${port}/voice`);
  console.log(`  audio in -> Sarvam ASR -> LLM -> ElevenLabs TTS -> audio out\n`);
});

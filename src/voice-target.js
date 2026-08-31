// Attacking a VOICE agent.
//
// A voice agent is ASR -> LLM -> TTS. Testing only its text brain misses the
// failures that are specific to voice: the ASR mishearing a code-switched
// sentence, the agent behaving differently when it is under time pressure in a
// call, guardrails thinned out to fit a sub-300ms budget.
//
// So we actually speak at it and listen to the answer:
//
//   attack text --TTS--> [audio] --> their voice agent --> [audio] --STT--> text
//
// Turn-based, not real-time streaming. That keeps it honest and buildable: we
// are testing what the agent DECIDES, not its barge-in latency.
//
// Requires ELEVENLABS_API_KEY (to speak) and SARVAM_API_KEY (to hear).

import { speakAsAttacker, transcribe, voiceReady, sttReady } from './voice.js';

const TIMEOUT_MS = Number(process.env.VOICE_TIMEOUT_MS || 45000);

export const voiceModeReady = () => voiceReady() && sttReady();

export function voiceModeStatus() {
  return {
    ready: voiceModeReady(),
    speak: voiceReady(),   // ElevenLabs
    hear: sttReady(),      // Sarvam
    missing: [
      !voiceReady() ? 'ELEVENLABS_API_KEY (to speak to the agent)' : null,
      !sttReady() ? 'SARVAM_API_KEY (to hear its reply)' : null,
    ].filter(Boolean),
  };
}

/** What we send. Most voice endpoints take an audio file; some want a session id. */
function buildForm(audio, target, history) {
  const form = new FormData();
  form.append('audio', new Blob([audio], { type: 'audio/mpeg' }), 'turn.mp3');
  form.append('turn', String(Math.ceil(history.length / 2) + 1));
  if (target.sessionId) form.append('session_id', target.sessionId);
  return form;
}

/**
 * One spoken turn against a live voice agent.
 * target = { url, headers?, languageCode? }
 * Returns { text, audioIn, audioOut, heard } so the UI can play both sides.
 */
export async function voiceTargetReply(target, history) {
  if (!voiceModeReady()) {
    throw new Error('Voice mode needs both keys: ' + voiceModeStatus().missing.join(' and '));
  }

  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser) throw new Error('Nothing to say to the agent.');

  // 1. speak the attack
  const audioIn = await speakAsAttacker(lastUser.content);

  // 2. send it to the agent and get audio back
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let audioOut;
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { ...(target.headers || {}) },   // no content-type: FormData sets its own boundary
      body: buildForm(audioIn, target, history),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`Voice agent returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      // Some platforms reply with JSON carrying base64 audio or a plain transcript.
      const d = await res.json();
      if (d.text || d.transcript) return { text: (d.text || d.transcript).trim(), audioIn, audioOut: null, heard: null };
      const b64 = d.audio || d.audio_base64 || d.audioContent;
      if (!b64) throw new Error('JSON reply contained neither text nor audio.');
      audioOut = Buffer.from(b64, 'base64');
    } else {
      audioOut = Buffer.from(await res.arrayBuffer());
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Voice agent did not respond within ${TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!audioOut?.length) throw new Error('Voice agent returned empty audio.');

  // 3. hear what it said - codemix, so Hinglish survives the trip
  const heard = await transcribe(audioOut, { languageCode: target.languageCode || 'hi-IN' });
  return { text: heard.text, audioIn, audioOut, heard };
}

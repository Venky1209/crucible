// Render an attack transcript as audio (ElevenLabs).
//
// Why this is a feature and not a gimmick: reading a transcript where an agent
// gives away a refund is easy to skim past. HEARING a calm, plausible voice talk
// your agent into it is what makes a support manager act. Same evidence, far
// higher conviction - and eleven_multilingual_v2 also speaks the Hinglish that
// the code-switching attack produces, which a English-only voice cannot.
//
// Entirely optional. With no ELEVENLABS_API_KEY the feature is simply absent.

const API = 'https://api.elevenlabs.io/v1';
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

export const voiceReady = () => Boolean(process.env.ELEVENLABS_API_KEY);

const headers = () => ({
  'xi-api-key': process.env.ELEVENLABS_API_KEY,
  'content-type': 'application/json',
});

/** Ask the account which voices it has - never hardcode an id that may not exist. */
export async function listVoices() {
  const res = await fetch(`${API}/voices`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.voices || []).map((v) => ({ id: v.voice_id, name: v.name }));
}

/** Two distinct voices: one for the attacker, one for the agent. */
let cached = null;
async function pickVoices() {
  if (cached) return cached;
  const voices = await listVoices();
  if (voices.length < 1) throw new Error('No voices available on this ElevenLabs account.');
  cached = {
    attacker: process.env.ELEVENLABS_VOICE_ATTACKER || voices[0].id,
    agent: process.env.ELEVENLABS_VOICE_AGENT || (voices[1]?.id ?? voices[0].id),
    names: { attacker: voices[0].name, agent: voices[1]?.name ?? voices[0].name },
  };
  return cached;
}

async function speak(text, voiceId) {
  const res = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      text,
      model_id: MODEL,
      voice_settings: { stability: 0.45, similarity_boost: 0.75, speed: 1.0 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Turn a transcript into one mp3, alternating voices.
 * transcript = [{ role: 'adversary' | 'target', content }]
 *
 * Constant-bitrate mp3 segments from one encoder concatenate cleanly enough for
 * browser playback; this is a demo artefact, not a mastering pipeline.
 */
export async function renderTranscript(transcript, { maxTurns = 8, maxChars = 600 } = {}) {
  if (!voiceReady()) throw new Error('ELEVENLABS_API_KEY is not set.');
  const v = await pickVoices();

  const turns = transcript.slice(0, maxTurns);
  const parts = [];
  for (const t of turns) {
    const text = String(t.content || '').slice(0, maxChars).trim();
    if (!text) continue;
    parts.push(await speak(text, t.role === 'adversary' ? v.attacker : v.agent));
  }
  if (!parts.length) throw new Error('Nothing to speak.');
  return { audio: Buffer.concat(parts), voices: v.names, turns: turns.length };
}

// ── the return leg: hearing what the agent said ──────────────────────────────
// Sarvam saaras:v3 with mode=codemix is built for code-mixed audio. That matters:
// the whole point of the code-switching attack is Hinglish, and an English-only
// transcriber would mangle the agent's reply and make the judge score noise.

export const sttReady = () => Boolean(process.env.SARVAM_API_KEY);

/** audio Buffer -> { text, language, confidence } */
export async function transcribe(audio, { languageCode = 'hi-IN' } = {}) {
  if (!sttReady()) throw new Error('SARVAM_API_KEY is not set (needed to hear the agent).');

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'reply.mp3');
  form.append('model', process.env.SARVAM_STT_MODEL || 'saaras:v3');
  form.append('mode', 'codemix');
  form.append('language_code', languageCode);

  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY },
    body: form,
  });
  if (!res.ok) throw new Error(`Sarvam STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const d = await res.json();
  const text = (d.transcript || '').trim();
  if (!text) throw new Error('Transcription came back empty - the agent may have returned silence.');
  return { text, language: d.language_code, confidence: d.language_probability };
}

/** One line of attack text -> spoken audio, using the attacker's voice. */
export async function speakAsAttacker(text) {
  if (!voiceReady()) throw new Error('ELEVENLABS_API_KEY is not set (needed to speak to the agent).');
  const v = await pickVoices();
  return speak(text, v.attacker);
}

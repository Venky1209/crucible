// ── AGENT DETECTION ──────────────────────────────────────────────────────────
//
// "Paste your system prompt" assumes the user knows where their prompt lives and
// can be bothered to find it. In practice an agent on someone's machine is one
// of a handful of concrete things: an Assistant JSON, a Dify DSL export, a
// Flowise flow, a prompt in a .md file, or a string assignment buried in source.
//
// So: drop the file in and we find the agent definition ourselves, tell you what
// we found and how confident we are, and never silently guess.
//
// No YAML dependency on purpose - we scan for the keys that matter rather than
// parsing a whole document format, and we say when we are unsure.

const MAX_BYTES = 2 * 1024 * 1024;

/** Keys that hold a system prompt, most specific first. */
const PROMPT_KEYS = [
  'instructions',        // OpenAI Assistants
  'system_prompt', 'systemPrompt', 'system_message', 'systemMessage',
  'system', 'pre_prompt', 'prePrompt',   // Dify
  'prompt', 'persona', 'role', 'description',
];

const ENDPOINT_KEYS = ['endpoint', 'url', 'base_url', 'baseUrl', 'api_url', 'apiUrl'];

const isPrompt = (v) => typeof v === 'string' && v.trim().length >= 40;

/** Walk an object for the first plausible prompt, remembering where it came from. */
function findInObject(obj, depth = 0, path = []) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;

  for (const key of PROMPT_KEYS) {
    if (isPrompt(obj[key])) return { prompt: obj[key].trim(), at: [...path, key].join('.') };
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      const hit = findInObject(v, depth + 1, [...path, k]);
      if (hit) return hit;
    }
  }
  return null;
}

function findEndpoint(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const key of ENDPOINT_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const hit = findEndpoint(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// ── format handlers ──────────────────────────────────────────────────────────

function fromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }

  // OpenAI Assistant / Agent export - the most recognisable shape
  if (typeof data?.instructions === 'string' && (data.model || data.id || data.name)) {
    return {
      kind: 'OpenAI Assistant',
      name: data.name || data.id || null,
      prompt: data.instructions.trim(),
      confidence: 'high',
      note: data.model ? `Declared model: ${data.model}` : '',
    };
  }

  // Flowise / Langflow: prompt lives on a node
  const nodes = data?.nodes || data?.data?.nodes;
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      const hit = findInObject(n?.data?.inputs || n?.data || n);
      if (hit) return {
        kind: 'Flow export (Flowise / Langflow)',
        name: data.name || n?.data?.label || null,
        prompt: hit.prompt, confidence: 'medium',
        note: `Found on a node at ${hit.at}. Check it is the right one if the flow has several.`,
      };
    }
  }

  const hit = findInObject(data);
  if (hit) return {
    kind: 'JSON config',
    name: data.name || data.title || null,
    prompt: hit.prompt,
    confidence: hit.at.split('.').length === 1 ? 'high' : 'medium',
    note: `Read from "${hit.at}".`,
    endpoint: findEndpoint(data),
  };
  return null;
}

/** Light YAML scan: block scalars and quoted values for the keys we care about. */
function fromYaml(text) {
  for (const key of PROMPT_KEYS) {
    // key: | / key: > followed by an indented block
    const block = new RegExp(`^\\s*${key}\\s*:\\s*[|>][-+]?\\s*\\n((?:[ \\t]+.*\\n?)+)`, 'im');
    const m = text.match(block);
    if (m) {
      const body = m[1].replace(/^[ \t]{1,}/gm, '').trim();
      if (body.length >= 40) return {
        kind: 'YAML config', name: (text.match(/^\s*name\s*:\s*(.+)$/im) || [])[1]?.trim() || null,
        prompt: body, confidence: 'high', note: `Read from the "${key}" block.`,
      };
    }
    // key: "single line value"
    const inline = new RegExp(`^\\s*${key}\\s*:\\s*["']([^"']{40,})["']\\s*$`, 'im');
    const i = text.match(inline);
    if (i) return {
      kind: 'YAML config', name: null, prompt: i[1].trim(),
      confidence: 'medium', note: `Read from the "${key}" line.`,
    };
  }
  return null;
}

/** Source files: a prompt assigned to a recognisable variable. */
function fromSource(text) {
  const names = 'SYSTEM_PROMPT|SYSTEM|systemPrompt|system_prompt|AGENT_PROMPT|INSTRUCTIONS|PROMPT|DEFAULT_TARGET_PROMPT';
  const patterns = [
    // python triple-quoted
    new RegExp(`(?:${names})\\s*=\\s*(?:r|f)?"""([\\s\\S]{40,}?)"""`),
    new RegExp(`(?:${names})\\s*=\\s*(?:r|f)?'''([\\s\\S]{40,}?)'''`),
    // js/ts template literal
    new RegExp(`(?:${names})\\s*=\\s*\`([\\s\\S]{40,}?)\``),
    // object property: system: `...` / instructions: "..."
    new RegExp(`(?:system|instructions|systemPrompt)\\s*:\\s*\`([\\s\\S]{40,}?)\``),
    new RegExp(`(?:system|instructions|systemPrompt)\\s*:\\s*"([^"]{40,})"`),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return {
      kind: 'Source file', name: null, prompt: m[1].trim(),
      confidence: 'medium',
      note: 'Extracted from a string assignment - check nothing was truncated.',
    };
  }
  return null;
}

/**
 * Detect an agent definition in one uploaded file.
 * Returns { found, kind, name, prompt, endpoint?, confidence, note } or a
 * found:false with a reason. Never guesses silently.
 */
export function extractAgent(filename = '', text = '') {
  if (typeof text !== 'string' || !text.trim()) {
    return { found: false, reason: 'That file is empty.' };
  }
  if (text.length > MAX_BYTES) {
    return { found: false, reason: 'File is larger than 2MB.' };
  }

  const ext = (filename.split('.').pop() || '').toLowerCase();
  const trimmed = text.trim();

  let hit = null;
  if (ext === 'json' || trimmed.startsWith('{') || trimmed.startsWith('[')) hit = fromJson(trimmed);
  if (!hit && (ext === 'yaml' || ext === 'yml')) hit = fromYaml(text);
  if (!hit && ['py', 'js', 'ts', 'mjs', 'tsx', 'jsx', 'rb', 'go', 'java'].includes(ext)) hit = fromSource(text);

  // A .md or .txt file usually IS the prompt.
  if (!hit && ['md', 'txt', 'markdown', 'prompt', ''].includes(ext) && trimmed.length >= 40) {
    hit = {
      kind: ext === 'md' || ext === 'markdown' ? 'Markdown prompt' : 'Plain text prompt',
      name: null, prompt: trimmed, confidence: 'high',
      note: 'Whole file treated as the system prompt.',
    };
  }

  // Last resort: any format, scan as source, then as prose.
  if (!hit) hit = fromSource(text);
  if (!hit && trimmed.length >= 80 && !/[{};]\s*$/m.test(trimmed.slice(0, 200))) {
    hit = {
      kind: 'Unrecognised file', name: null, prompt: trimmed, confidence: 'low',
      note: 'We could not identify the format, so the whole file was used. Check it before running.',
    };
  }

  if (!hit) {
    return {
      found: false,
      reason: 'No agent definition found. Supported: OpenAI Assistant JSON, Dify/YAML config, ' +
              'Flowise or Langflow exports, a prompt in .md/.txt, or a source file with a ' +
              'SYSTEM_PROMPT assignment.',
    };
  }

  return { found: true, filename, ...hit, chars: hit.prompt.length };
}

/** Pick the best candidate when a whole folder is dropped in. */
export function extractBest(files = []) {
  const rank = { high: 3, medium: 2, low: 1 };
  const hits = files
    .map((f) => extractAgent(f.name, f.text))
    .filter((r) => r.found)
    .sort((a, b) => (rank[b.confidence] - rank[a.confidence]) || (b.chars - a.chars));

  if (!hits.length) {
    return { found: false, reason: 'No agent definition found in any of those files.' };
  }
  return { ...hits[0], alternatives: hits.slice(1, 5).map(
    ({ filename, kind, chars, confidence }) => ({ filename, kind, chars, confidence })) };
}

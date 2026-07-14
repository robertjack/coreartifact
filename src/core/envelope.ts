// The spool envelope (v1) — parse and serialize spool lines.
//
// Byte preservation is a contract: `parseEnvelope` hands back the `event`
// member's exact source text, never a re-serialized object, so ingest can
// store the payload verbatim without reordering its keys. The decoded
// `event` view exists separately for consumers that need to read nesting
// keys (agent_id, tool_use_id, ...); only `eventRaw` may ever be persisted.

export interface EnvelopeGit {
  head?: string;
  dirty?: boolean;
}

export interface Envelope {
  v: 1;
  ts: string;
  git?: EnvelopeGit;
}

export type ParseEnvelopeResult =
  | { ok: true; envelope: Envelope; event: unknown; eventRaw: string }
  | { ok: false; reason: string };

// Scans a single JSON value starting at `start` (the value's first
// character) and returns the index just past its last character. Handles
// strings, objects and arrays (skipping over nested string contents so
// braces/brackets inside strings are never mistaken for structure) and
// primitives (numbers, true, false, null) by scanning to the next
// structural delimiter.
function scanJsonValue(text: string, start: number): number {
  let i = start;
  const first = text[i];

  if (first === '"') {
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        break;
      }
      i++;
    }
    return i;
  }

  if (first === '{' || first === '[') {
    let depth = 0;
    let inString = false;
    while (i < text.length) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '"') inString = false;
        i++;
        continue;
      }
      if (ch === '"') {
        inString = true;
        i++;
        continue;
      }
      if (ch === '{' || ch === '[') {
        depth++;
        i++;
        continue;
      }
      if (ch === '}' || ch === ']') {
        depth--;
        i++;
        if (depth === 0) return i;
        continue;
      }
      i++;
    }
    return i;
  }

  while (i < text.length && !',}] \t\n\r'.includes(text[i])) i++;
  return i;
}

// Walks the top-level members of a JSON object and returns each member's
// exact source-text span, keyed by its decoded key name. Returns null if
// `text` is not a well-formed JSON object.
function extractTopLevelEntries(text: string): Map<string, string> | null {
  let i = 0;
  const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

  while (i < text.length && isSpace(text[i])) i++;
  if (text[i] !== '{') return null;
  i++;

  const entries = new Map<string, string>();

  for (;;) {
    while (i < text.length && isSpace(text[i])) i++;
    if (i >= text.length) return null;
    if (text[i] === '}') {
      i++;
      break;
    }
    if (text[i] !== '"') return null;

    const keyEnd = scanJsonValue(text, i);
    let key: string;
    try {
      key = JSON.parse(text.slice(i, keyEnd));
    } catch {
      return null;
    }
    i = keyEnd;

    while (i < text.length && isSpace(text[i])) i++;
    if (text[i] !== ':') return null;
    i++;
    while (i < text.length && isSpace(text[i])) i++;

    const valueStart = i;
    const valueEnd = scanJsonValue(text, i);
    if (valueEnd <= valueStart) return null;
    entries.set(key, text.slice(valueStart, valueEnd));
    i = valueEnd;

    while (i < text.length && isSpace(text[i])) i++;
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] === '}') {
      i++;
      break;
    }
    return null;
  }

  return entries;
}

export function parseEnvelope(line: string): ParseEnvelopeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'line is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'envelope is not a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.v !== 1) {
    return { ok: false, reason: 'unsupported envelope version' };
  }
  if (typeof obj.ts !== 'string') {
    return { ok: false, reason: 'envelope is missing a string ts' };
  }
  if (!('event' in obj)) {
    return { ok: false, reason: 'envelope is missing an event member' };
  }

  const entries = extractTopLevelEntries(line);
  const eventRaw = entries?.get('event');
  if (!entries || eventRaw === undefined) {
    return { ok: false, reason: 'could not locate the event member source text' };
  }

  const envelope: Envelope = { v: 1, ts: obj.ts };
  if (obj.git !== undefined && obj.git !== null && typeof obj.git === 'object') {
    envelope.git = obj.git as EnvelopeGit;
  }

  return { ok: true, envelope, event: obj.event, eventRaw };
}

export interface SerializeEnvelopeInput {
  ts: string;
  // Raw JSON text of the event payload, embedded verbatim (never
  // re-serialized) to preserve key order and byte-for-byte content.
  eventRaw: string;
  git?: EnvelopeGit;
}

export function serializeEnvelope(input: SerializeEnvelopeInput): string {
  const parts = [`"v":1`, `"ts":${JSON.stringify(input.ts)}`, `"event":${input.eventRaw}`];
  if (input.git) {
    parts.push(`"git":${JSON.stringify(input.git)}`);
  }
  return `{${parts.join(',')}}`;
}

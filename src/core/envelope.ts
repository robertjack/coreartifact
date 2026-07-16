// The spool envelope (v1) — parse and serialize spool lines.
//
// Byte preservation is a contract, not an optimization: `parseEnvelope`
// hands back the `event` member's exact source-text span, never a
// re-serialized object, so a consumer that stores `eventText` verbatim never
// reorders keys. The decoded `event` view exists alongside it purely for
// field promotion (reading nesting keys); only `eventText` may ever be
// persisted to the spool or ledger.
//
// Parsing is total: every path returns a typed result, never throws, so
// ingest can skip a corrupt line and keep going.

export interface EnvelopeGit {
  head?: string;
  dirty?: boolean;
}

// The two ways a caller may hand serializeEnvelope its payload are tagged as
// distinct, explicit fields rather than folded into one field whose meaning
// depends on its runtime type. Folding them (a single `event: unknown` that
// treats a *string* as "already-serialized, embed verbatim") is the trap
// documented in the module header: raw stdin text carries a trailing
// newline, and embedding it unvalidated writes a multi-line record into the
// append-only spool, desynchronizing every subsequent line ordinal forever.
export type SerializeEnvelopeInput =
  | {
      v: 1;
      ts: string;
      // An arbitrary decoded value to be JSON-encoded here.
      event: unknown;
      eventText?: undefined;
      git?: EnvelopeGit;
    }
  | {
      v: 1;
      ts: string;
      event?: undefined;
      // Pre-serialized JSON text of the event payload (e.g. raw stdin text
      // from a hook artifact that is forbidden from parsing it), embedded
      // verbatim preserving key order. Hard-validated before embedding: see
      // serializeEnvelope.
      eventText: string;
      git?: EnvelopeGit;
    };

export type SerializeEnvelopeResult =
  | { ok: true; line: string }
  | { ok: false; reason: string };

export type ParseEnvelopeResult =
  | { ok: true; ts: string; event: unknown; eventText: string; git?: EnvelopeGit }
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
      if (ch === "\\") {
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

  if (first === "{" || first === "[") {
    let depth = 0;
    let inString = false;
    while (i < text.length) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") {
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
      if (ch === "{" || ch === "[") {
        depth++;
        i++;
        continue;
      }
      if (ch === "}" || ch === "]") {
        depth--;
        i++;
        if (depth === 0) return i;
        continue;
      }
      i++;
    }
    return i;
  }

  while (i < text.length && !",}] \t\n\r".includes(text[i])) i++;
  return i;
}

// Walks the top-level members of a JSON object and returns each member's
// exact source-text span, keyed by its decoded key name. Returns null if
// `text` is not a well-formed JSON object.
function extractTopLevelEntries(text: string): Map<string, string> | null {
  let i = 0;
  const isSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

  while (i < text.length && isSpace(text[i])) i++;
  if (text[i] !== "{") return null;
  i++;

  const entries = new Map<string, string>();

  for (;;) {
    while (i < text.length && isSpace(text[i])) i++;
    if (i >= text.length) return null;
    if (text[i] === "}") {
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
    if (text[i] !== ":") return null;
    i++;
    while (i < text.length && isSpace(text[i])) i++;

    const valueStart = i;
    const valueEnd = scanJsonValue(text, i);
    if (valueEnd <= valueStart) return null;
    entries.set(key, text.slice(valueStart, valueEnd));
    i = valueEnd;

    while (i < text.length && isSpace(text[i])) i++;
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] === "}") {
      i++;
      break;
    }
    return null;
  }

  return entries;
}

// The check line (schema.md Surface 1) — the second `v: 1` spool variant,
// written by the CLI's `check` command (never the hook artifact). Fields
// pass through exactly as parsed: `session_id`/`bound_by` are `null` when
// standalone, never defaulted (degradation law, docs/gotchas.md entry 5).
export interface CheckFields {
  name: string;
  argv: string[];
  exit: number;
  output: string;
  truncated: boolean;
  session_id: string | null;
  bound_by: "single-open" | "explicit" | null;
}

export type SpoolLineParseResult =
  | { kind: "event"; ok: true; ts: string; event: unknown; eventText: string; git?: EnvelopeGit }
  | { kind: "check"; ok: true; ts: string; check: CheckFields }
  | { kind: "corrupt"; ok: false; reason: string };

// Discriminates a physical spool line by which top-level member it carries
// (schema.md "Ingest discrimination and the corrupt-line rule") — not by a
// version bump. A `v: 1` line with exactly one of `event`/`check` routes to
// the corresponding variant; not valid JSON, wrong version, neither member,
// or both members is `corrupt` — a typed classification, never a guess.
export function parseSpoolLine(line: string): SpoolLineParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "corrupt", ok: false, reason: "line is not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "corrupt", ok: false, reason: "line is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) {
    return { kind: "corrupt", ok: false, reason: "unsupported line version" };
  }

  const hasEvent = "event" in obj;
  const hasCheck = "check" in obj;
  if (hasEvent === hasCheck) {
    return {
      kind: "corrupt",
      ok: false,
      reason: hasEvent
        ? "line carries both an event and a check member"
        : "line carries neither an event nor a check member",
    };
  }

  if (hasEvent) {
    const parsedEnvelope = parseEnvelope(line);
    if (!parsedEnvelope.ok) {
      return { kind: "corrupt", ok: false, reason: parsedEnvelope.reason };
    }
    return {
      kind: "event",
      ok: true,
      ts: parsedEnvelope.ts,
      event: parsedEnvelope.event,
      eventText: parsedEnvelope.eventText,
      git: parsedEnvelope.git,
    };
  }

  if (typeof obj.ts !== "string") {
    return { kind: "corrupt", ok: false, reason: "line is missing a string ts" };
  }

  const rawCheck = obj.check;
  if (typeof rawCheck !== "object" || rawCheck === null || Array.isArray(rawCheck)) {
    return { kind: "corrupt", ok: false, reason: "check member is not an object" };
  }
  const c = rawCheck as Record<string, unknown>;

  if (typeof c.name !== "string") {
    return { kind: "corrupt", ok: false, reason: "check.name is not a string" };
  }
  if (!Array.isArray(c.argv) || !c.argv.every((a) => typeof a === "string")) {
    return { kind: "corrupt", ok: false, reason: "check.argv is not an array of strings" };
  }
  if (typeof c.exit !== "number") {
    return { kind: "corrupt", ok: false, reason: "check.exit is not a number" };
  }
  if (typeof c.output !== "string") {
    return { kind: "corrupt", ok: false, reason: "check.output is not a string" };
  }
  if (typeof c.truncated !== "boolean") {
    return { kind: "corrupt", ok: false, reason: "check.truncated is not a boolean" };
  }
  if (!(c.session_id === null || typeof c.session_id === "string")) {
    return { kind: "corrupt", ok: false, reason: "check.session_id is not a string or null" };
  }
  if (!(c.bound_by === null || c.bound_by === "single-open" || c.bound_by === "explicit")) {
    return { kind: "corrupt", ok: false, reason: "check.bound_by is not a recognized value" };
  }

  return {
    kind: "check",
    ok: true,
    ts: obj.ts,
    check: {
      name: c.name,
      argv: c.argv as string[],
      exit: c.exit,
      output: c.output,
      truncated: c.truncated,
      session_id: c.session_id as string | null,
      bound_by: c.bound_by as "single-open" | "explicit" | null,
    },
  };
}

export function parseEnvelope(line: string): ParseEnvelopeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "line is not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "envelope is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.v !== 1) {
    return { ok: false, reason: "unsupported envelope version" };
  }
  if (typeof obj.ts !== "string") {
    return { ok: false, reason: "envelope is missing a string ts" };
  }
  if (!("event" in obj)) {
    return { ok: false, reason: "envelope is missing an event member" };
  }

  const entries = extractTopLevelEntries(line);
  const eventText = entries?.get("event");
  if (!entries || eventText === undefined) {
    return { ok: false, reason: "could not locate the event member source text" };
  }

  const result: ParseEnvelopeResult = { ok: true, ts: obj.ts, event: obj.event, eventText };

  // The git facet follows the degradation law: a key is present with its
  // genuine value, or ABSENT. A malformed head (empty string, null, or a
  // non-string) must never be blind-cast into the typed contract — strip it
  // rather than admit a fabricated value into the evidence spine.
  if (obj.git !== undefined && obj.git !== null && typeof obj.git === "object" && !Array.isArray(obj.git)) {
    const rawGit = obj.git as Record<string, unknown>;
    const git: EnvelopeGit = {};
    if (typeof rawGit.head === "string" && rawGit.head.length > 0) {
      git.head = rawGit.head;
    }
    if (typeof rawGit.dirty === "boolean") {
      git.dirty = rawGit.dirty;
    }
    result.git = git;
  }

  return result;
}

function buildGitPart(git: EnvelopeGit | undefined): string | undefined {
  if (!git) return undefined;
  const fields: string[] = [];
  if (typeof git.head === "string" && git.head.length > 0) {
    fields.push(`"head":${JSON.stringify(git.head)}`);
  }
  if (typeof git.dirty === "boolean") {
    fields.push(`"dirty":${JSON.stringify(git.dirty)}`);
  }
  return fields.length > 0 ? `{${fields.join(",")}}` : undefined;
}

// Matches any raw control character (0x00-0x1F), including the newline and
// carriage-return bytes that a JSON.parse call happily accepts as
// insignificant whitespace *outside* a string. A pretty-printed payload with
// real newlines between its keys is valid JSON by that rule, but embedding
// it verbatim would still write a multi-line record into the append-only
// spool — so this check is stricter than "parses as JSON" on purpose.
const CONTROL_CHAR_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`);

// Serialization is one line, always. The two ways a caller may supply the
// payload are tagged as distinct fields (see SerializeEnvelopeInput) so
// "decoded value, JSON.stringify it here" and "already-serialized text,
// embed verbatim" can never be confused:
//
//  - `event` (decoded): JSON.stringify escapes embedded newlines and
//    control characters as `\n`/`\t` sequences rather than literal bytes,
//    so the result is always exactly one physical line.
//  - `eventText` (pre-serialized, e.g. raw hook stdin the caller is
//    forbidden from parsing): hard-validated *before* embedding — it must
//    parse as JSON and must contain no raw control character. Anything else
//    is a typed failure, never a throw and never a silent multi-line write.
//
// Total: never throws, and the result (when ok) is always exactly one
// physical line for any payload.
export function serializeEnvelope(input: SerializeEnvelopeInput): SerializeEnvelopeResult {
  let eventText: string;

  if (input.eventText !== undefined) {
    // Control-char rejection runs on the ORIGINAL text, before any
    // trimming: a trailing/interior newline or tab is what the F1 trap
    // (raw stdin text embedded unvalidated -> multi-line spool corruption)
    // depends on catching, and trimming first would silently strip exactly
    // the bytes that check exists to reject.
    if (CONTROL_CHAR_RE.test(input.eventText)) {
      return { ok: false, reason: "eventText contains a raw control character (e.g. a newline)" };
    }
    // Only after that: trim plain whitespace padding (e.g. spaces, which
    // are not control characters and so JSON.parse tolerates them) before
    // validating/embedding. Embedding it verbatim would accept bytes the
    // parser cannot give back byte-for-byte (`{"a":1} ` round-trips as
    // `{"a":1}`) — the writer must not accept and alter (V3, 2026-07-14).
    const text = input.eventText.trim();
    try {
      JSON.parse(text);
    } catch {
      return { ok: false, reason: "eventText is not valid JSON" };
    }
    eventText = text;
  } else {
    // Totality means totality on this path too (V2, 2026-07-14):
    // JSON.stringify does not return undefined for a BigInt, a circular
    // reference, or a throwing toJSON/getter/proxy trap — it throws, and
    // the `=== undefined` guard below catches none of those. Wrap the
    // encode itself so every failure becomes a typed result, never a thrown
    // exception.
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(input.event);
    } catch (err) {
      // Do NOT interpolate the thrown value: String(err) re-throws when the
      // value's toString/Symbol.toPrimitive throws (or when it is an Error
      // whose `message` getter throws), and the exception escapes the very
      // function whose contract is "never throws". Read only the name, and
      // only when it is safely readable.
      let kind = "non-Error thrown";
      try {
        if (err instanceof Error && typeof err.name === "string") kind = err.name;
      } catch {
        // a throwing `name` getter — keep the fallback
      }
      return { ok: false, reason: `event is not JSON-serializable (${kind})` };
    }
    if (encoded === undefined) {
      return { ok: false, reason: "event is not JSON-serializable (e.g. undefined or a function)" };
    }
    eventText = encoded;
  }

  const parts = [`"v":1`, `"ts":${JSON.stringify(input.ts)}`, `"event":${eventText}`];

  const gitPart = buildGitPart(input.git);
  if (gitPart) {
    parts.push(`"git":${gitPart}`);
  }

  const line = `${parts.join(",")}`;
  // Defense in depth: even though every code path above is constructed from
  // JSON.stringify output or a control-char-free validated string, assert
  // the single-line invariant directly rather than trusting the
  // construction.
  if (CONTROL_CHAR_RE.test(line)) {
    return { ok: false, reason: "serialized envelope unexpectedly contains a control character" };
  }

  return { ok: true, line: `{${line}}\n` };
}

export interface SerializeCheckLineInput {
  v: 1;
  ts: string;
  check: {
    name: string;
    // Typed `unknown` at the boundary (rather than `string[]`) so a hostile
    // caller's circular/BigInt-bearing element becomes a typed failure below
    // instead of a compile-time lie about what serializeCheckLine accepts.
    argv: unknown;
    exit: unknown;
    output: string;
    truncated: boolean;
    session_id: string | null;
    bound_by: "single-open" | "explicit" | null;
  };
}

export type SerializeCheckLineResult = { ok: true; line: string } | { ok: false; reason: string };

// Serializes a check line (schema.md Surface 1). Same guarantees as
// serializeEnvelope: exactly one physical line, JSON.stringify escapes any
// embedded newline/control character in `output` rather than emitting it
// raw, and hostile input (a BigInt `exit`, a circular `argv`) returns a
// typed failure instead of throwing.
export function serializeCheckLine(input: SerializeCheckLineInput): SerializeCheckLineResult {
  if (input.v !== 1) {
    return { ok: false, reason: "v must be 1" };
  }
  if (typeof input.ts !== "string") {
    return { ok: false, reason: "ts must be a string" };
  }
  const check = input.check;
  if (typeof check !== "object" || check === null) {
    return { ok: false, reason: "check must be an object" };
  }

  let checkText: string;
  try {
    const encoded = JSON.stringify({
      name: check.name,
      argv: check.argv,
      exit: check.exit,
      output: check.output,
      truncated: check.truncated,
      session_id: check.session_id,
      bound_by: check.bound_by,
    });
    if (encoded === undefined) {
      return { ok: false, reason: "check is not JSON-serializable" };
    }
    checkText = encoded;
  } catch (err) {
    // Same discipline as serializeEnvelope: never interpolate the thrown
    // value itself -- a throwing toString/Symbol.toPrimitive/message getter
    // would re-throw out of this "never throws" function.
    let kind = "non-Error thrown";
    try {
      if (err instanceof Error && typeof err.name === "string") kind = err.name;
    } catch {
      // a throwing `name` getter — keep the fallback
    }
    return { ok: false, reason: `check is not JSON-serializable (${kind})` };
  }

  const line = `{"v":1,"ts":${JSON.stringify(input.ts)},"check":${checkText}}`;
  if (CONTROL_CHAR_RE.test(line)) {
    return { ok: false, reason: "serialized check line unexpectedly contains a control character" };
  }

  return { ok: true, line: `${line}\n` };
}

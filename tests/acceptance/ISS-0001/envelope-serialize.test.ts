import { describe, test, expect } from "vitest";

const MODULE_PATH = "../../../src/core/envelope";

async function loadEnvelopeModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

function stripTrailingNewline(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

describe("ISS-0001 core contracts: envelope serialize", () => {
  test("serializeEnvelope emits exactly one line: for any payload, including one containing embedded newlines or control characters, the output contains no interior newline and re-parses through parseEnvelope to a byte-identical payload; and it never emits an empty-string git head (absent is key-omitted).", async () => {
    const mod = await loadEnvelopeModule();
    if (!mod) throw new Error("src/core/envelope module not implemented yet");
    if (typeof mod.serializeEnvelope !== "function") {
      throw new Error("src/core/envelope does not export serializeEnvelope yet");
    }
    if (typeof mod.parseEnvelope !== "function") {
      throw new Error("src/core/envelope does not export parseEnvelope yet");
    }

    const ts = "2026-07-14T10:00:00.000Z";
    const payload = {
      note: "line one\nline two\ttabbed\x00embedded-null",
      nested: { more: "\r\ncarriage newline" },
    };

    const result = mod.serializeEnvelope({ v: 1, ts, event: payload });
    expect(result?.ok).toBe(true);
    const line: string = result.line;
    expect(typeof line).toBe("string");

    const body = stripTrailingNewline(line);
    expect(body.includes("\n")).toBe(false);

    const parsed = mod.parseEnvelope(line);
    expect(parsed?.ok).toBe(true);
    expect(JSON.parse(parsed.eventText)).toEqual(payload);

    // git head omission: an explicit empty string must never survive as ""
    const resultWithEmptyHead = mod.serializeEnvelope({
      v: 1,
      ts,
      event: payload,
      git: { head: "", dirty: true },
    });
    expect(resultWithEmptyHead?.ok).toBe(true);
    const parsedGit = JSON.parse(stripTrailingNewline(resultWithEmptyHead.line));
    if (parsedGit.git) {
      expect(Object.prototype.hasOwnProperty.call(parsedGit.git, "head")).toBe(false);
    }
  });

  // F1 (the trap): the hook artifact is forbidden by law from parsing the
  // payload, so a law-conformant caller hands serializeEnvelope the RAW
  // STDIN TEXT of the hook event via a pre-serialized `eventText` field —
  // and raw stdin carries a trailing newline. An implementation that
  // silently treats a string `event` as "already-serialized, embed
  // verbatim" writes a multi-physical-line record into the append-only
  // spool and desynchronizes every subsequent line_no forever. These cases
  // must never pass silently: they must be typed failures, never a throw
  // and never a multi-line write.
  test("serializeEnvelope rejects adversarial pre-serialized eventText (trailing newline, interior newline, control characters) as a typed failure rather than emitting a multi-line or corrupt record", async () => {
    const mod = await loadEnvelopeModule();
    if (!mod) throw new Error("src/core/envelope module not implemented yet");

    const ts = "2026-07-14T10:00:00.000Z";

    const adversarialEventTexts = [
      // Raw stdin text with the trailing newline every real hook payload
      // carries.
      '{"hook_event_name":"Stop"}\n',
      // A pretty-printed payload: valid JSON per JSON.parse (whitespace
      // between tokens is insignificant), but it still contains a raw
      // interior newline, which the single-line spool contract forbids.
      '{\n  "hook_event_name": "Stop"\n}',
      // A raw control character (tab) embedded in the text.
      '{"note":"a\tb"}',
      // A raw NUL byte embedded in the text.
      '{"note":"a\x00b"}',
    ];

    for (const eventText of adversarialEventTexts) {
      const result = mod.serializeEnvelope({ v: 1, ts, eventText });
      expect(result?.ok, `expected a typed failure for eventText ${JSON.stringify(eventText)}`).toBe(
        false,
      );
    }
  });

  test("serializeEnvelope rejects a decoded `event` of undefined rather than emitting the literal text `undefined` (which is not valid JSON)", async () => {
    const mod = await loadEnvelopeModule();
    if (!mod) throw new Error("src/core/envelope module not implemented yet");

    const result = mod.serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", event: undefined });
    expect(result?.ok).toBe(false);
  });

  test("serializeEnvelope accepts well-formed pre-serialized eventText verbatim, preserving key order, and it round-trips through parseEnvelope as exactly one physical line", async () => {
    const mod = await loadEnvelopeModule();
    if (!mod) throw new Error("src/core/envelope module not implemented yet");

    const eventText = '{"zebra":1,"apple":"two"}';
    const result = mod.serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", eventText });
    expect(result?.ok).toBe(true);
    const body = stripTrailingNewline(result.line);
    expect(body.includes("\n")).toBe(false);

    const parsed = mod.parseEnvelope(result.line);
    expect(parsed?.ok).toBe(true);
    expect(parsed.eventText).toBe(eventText);
  });
});

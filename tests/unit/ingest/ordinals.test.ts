// Pure unit tests for src/ingest/ordinals.ts (docs/issues/ISS-0006.md
// "Below-the-seam unit tests ... line-ordinal assignment across a corrupt
// line").
import { describe, it, expect } from "vitest";
import { sliceCompleteLines, assignLineOrdinals } from "../../../src/ingest/ordinals.js";
import { parseEnvelope } from "../../../src/core/envelope.js";

function envelopeLine(event: unknown): string {
  return JSON.stringify({ v: 1, ts: "2026-07-14T00:00:00.000Z", event });
}

describe("assignLineOrdinals", () => {
  it("assigns a corrupt line its own ordinal without shifting its neighbors'", () => {
    const rawLines = [
      envelopeLine({ session_id: "s1", hook_event_name: "SessionStart" }),
      "{this is not valid JSON}",
      envelopeLine({ session_id: "s1", hook_event_name: "UserPromptSubmit" }),
    ];

    const ordinals = assignLineOrdinals(0, rawLines);
    expect(ordinals.map((o) => o.lineNo)).toEqual([1, 2, 3]);

    const parsed = ordinals.map((o) => parseEnvelope(o.text));
    expect(parsed[0]!.ok).toBe(true);
    expect(parsed[1]!.ok).toBe(false); // the corrupt line: still occupies ordinal 2
    expect(parsed[2]!.ok).toBe(true);
    expect(ordinals[2]!.lineNo).toBe(3); // the line AFTER the corrupt one keeps its own ordinal
  });

  it("continues numbering from a supplied starting lines_seen, across incremental ingest", () => {
    const rawLines = [envelopeLine({ session_id: "s1", hook_event_name: "Stop" })];
    const ordinals = assignLineOrdinals(41, rawLines);
    expect(ordinals).toEqual([{ lineNo: 42, text: rawLines[0] }]);
  });

  it("returns an empty list for no new lines", () => {
    expect(assignLineOrdinals(5, [])).toEqual([]);
  });
});

describe("sliceCompleteLines", () => {
  function bufferOf(text: string): Buffer {
    return Buffer.from(text, "utf8");
  }

  it("reads complete newline-terminated lines and leaves a trailing partial line unconsumed", () => {
    const text = "line-one\nline-two\nline-three-partial-no-newline";
    const buffer = bufferOf(text);
    const { lines, endOffset } = sliceCompleteLines(buffer, 0);
    expect(lines).toEqual(["line-one", "line-two"]);
    expect(endOffset).toBe(bufferOf("line-one\nline-two\n").length);
    expect(buffer.subarray(endOffset).toString("utf8")).toBe("line-three-partial-no-newline");
  });

  it("resumes from a byte offset, never re-reading already-ingested lines", () => {
    const buffer = bufferOf("aaa\nbbb\nccc\n");
    const first = sliceCompleteLines(buffer, 0);
    expect(first.lines).toEqual(["aaa", "bbb", "ccc"]);

    const second = sliceCompleteLines(buffer, first.endOffset);
    expect(second.lines).toEqual([]);
    expect(second.endOffset).toBe(first.endOffset);
  });

  it("slices by true BYTE offset, not string character index, across multi-byte UTF-8 lines", () => {
    // "café" is 4 chars but 5 bytes in UTF-8 (é = 2 bytes) — a char-index
    // slice would misalign the second line's start by one byte.
    const buffer = bufferOf("café\nsecond\n");
    const { lines, endOffset } = sliceCompleteLines(buffer, 0);
    expect(lines).toEqual(["café", "second"]);
    expect(endOffset).toBe(buffer.length);
  });

  it("returns nothing for an empty buffer", () => {
    expect(sliceCompleteLines(bufferOf(""), 0)).toEqual({ lines: [], endOffset: 0 });
  });
});

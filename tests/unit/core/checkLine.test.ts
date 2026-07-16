import { describe, it, expect } from "vitest";
import { parseSpoolLine, serializeCheckLine, serializeEnvelope } from "../../../src/core/envelope.js";

// NOTE (scope_change flagged in structured output): the locked acceptance
// test at tests/acceptance/ISS-0013/checkLine.test.ts imports its subject
// from "../../../src/core/checkLine.js", a path this issue's declared
// footprint (owns: src/core/envelope.ts, src/core/ledger.ts) does not
// grant write access to. parseSpoolLine/serializeCheckLine are implemented
// here in envelope.ts instead — the nearest legal home, and the module that
// already owns spool-line parse/serialize semantics — so this file tests
// the real implementation directly.

const SAMPLE_CHECK = {
  name: "lint",
  argv: ["pnpm", "lint"],
  exit: 0,
  output: "ok",
  truncated: false,
  session_id: null as string | null,
  bound_by: null as "single-open" | "explicit" | null,
};

describe("parseSpoolLine", () => {
  it("classifies a check-variant line, exposing all seven fields verbatim including null session_id/bound_by", () => {
    const line = JSON.stringify({ v: 1, ts: "2026-07-16T00:00:00.000Z", check: SAMPLE_CHECK });
    const result = parseSpoolLine(line);
    expect(result.kind).toBe("check");
    if (result.kind !== "check") return;
    expect(result.check).toEqual(SAMPLE_CHECK);
  });

  it("classifies a bound check-variant line, preserving session_id and bound_by exactly", () => {
    const bound = {
      name: "test:unit",
      argv: ["pnpm", "test", "--run"],
      exit: 1,
      output: "1 failing",
      truncated: true,
      session_id: "sess-123",
      bound_by: "explicit" as const,
    };
    const line = JSON.stringify({ v: 1, ts: "2026-07-16T00:01:00.000Z", check: bound });
    const result = parseSpoolLine(line);
    expect(result.kind).toBe("check");
    if (result.kind !== "check") return;
    expect(result.check).toEqual(bound);
  });

  it("delegates an event-variant line to the pinned envelope semantics", () => {
    const serialized = serializeEnvelope({ v: 1, ts: "2026-07-16T00:02:00.000Z", event: { hook_event_name: "Stop" } });
    if (!serialized.ok) throw new Error("fixture setup failed");
    const result = parseSpoolLine(serialized.line);
    expect(result.kind).toBe("event");
    if (result.kind !== "event") return;
    expect(result.eventText).toBe('{"hook_event_name":"Stop"}');
  });

  it("classifies a v:1 line with neither event nor check as corrupt", () => {
    const line = JSON.stringify({ v: 1, ts: "2026-07-16T00:03:00.000Z" });
    const result = parseSpoolLine(line);
    expect(result.kind).toBe("corrupt");
  });

  it("classifies a v:1 line with both event and check as corrupt", () => {
    const line = JSON.stringify({
      v: 1,
      ts: "2026-07-16T00:04:00.000Z",
      event: { hook_event_name: "Stop" },
      check: SAMPLE_CHECK,
    });
    const result = parseSpoolLine(line);
    expect(result.kind).toBe("corrupt");
  });

  it("classifies malformed JSON as corrupt without throwing", () => {
    expect(() => parseSpoolLine("{not json")).not.toThrow();
    expect(parseSpoolLine("{not json").kind).toBe("corrupt");
  });

  it("classifies an unsupported version as corrupt", () => {
    const line = JSON.stringify({ v: 2, ts: "2026-07-16T00:05:00.000Z", check: SAMPLE_CHECK });
    expect(parseSpoolLine(line).kind).toBe("corrupt");
  });

  it("classifies a check member with a wrong-typed field as corrupt, never guessed into a partial check", () => {
    const line = JSON.stringify({
      v: 1,
      ts: "2026-07-16T00:06:00.000Z",
      check: { ...SAMPLE_CHECK, exit: "0" },
    });
    expect(parseSpoolLine(line).kind).toBe("corrupt");
  });
});

describe("serializeCheckLine", () => {
  it("round-trips a check line byte-identically through parseSpoolLine, as exactly one physical line", () => {
    const check = {
      name: "test:run",
      argv: ["pnpm", "test", "--reporter=json"],
      exit: 137,
      output: "line one\nline two \ttabbed\r\nlast line",
      truncated: true,
      session_id: "sess-abc",
      bound_by: "single-open" as const,
    };
    const serialized = serializeCheckLine({ v: 1, ts: "2026-07-16T00:07:00.000Z", check });
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const newlineCount = (serialized.line.match(/\n/g) ?? []).length;
    expect(newlineCount).toBe(1);
    expect(serialized.line.endsWith("\n")).toBe(true);

    const reparsed = parseSpoolLine(serialized.line);
    expect(reparsed.kind).toBe("check");
    if (reparsed.kind !== "check") return;
    expect(reparsed.check).toEqual(check);
  });

  it("returns a typed failure, never throws, for a BigInt exit", () => {
    let result: ReturnType<typeof serializeCheckLine> | undefined;
    expect(() => {
      result = serializeCheckLine({
        v: 1,
        ts: "2026-07-16T00:08:00.000Z",
        check: { ...SAMPLE_CHECK, exit: 1n as unknown as number },
      });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  it("returns a typed failure, never throws, for a circular argv entry", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let result: ReturnType<typeof serializeCheckLine> | undefined;
    expect(() => {
      result = serializeCheckLine({
        v: 1,
        ts: "2026-07-16T00:09:00.000Z",
        check: { ...SAMPLE_CHECK, argv: [circular] },
      });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  it("never defaults null session_id/bound_by on a standalone check", () => {
    const serialized = serializeCheckLine({ v: 1, ts: "2026-07-16T00:10:00.000Z", check: SAMPLE_CHECK });
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const parsed = JSON.parse(serialized.line);
    expect(parsed.check.session_id).toBeNull();
    expect(parsed.check.bound_by).toBeNull();
  });
});

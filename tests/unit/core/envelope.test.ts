import { describe, it, expect } from "vitest";
import { parseEnvelope, serializeEnvelope } from "../../../src/core/envelope.js";

describe("envelope", () => {
  describe("parseEnvelope", () => {
    it("rejects a line with an unsupported version", () => {
      const result = parseEnvelope('{"v":2,"ts":"2026-07-14T10:00:00.000Z","event":{}}');
      expect(result.ok).toBe(false);
    });

    it("rejects a line missing ts", () => {
      const result = parseEnvelope('{"v":1,"event":{}}');
      expect(result.ok).toBe(false);
    });

    it("rejects a non-object top level value", () => {
      const result = parseEnvelope("[1,2,3]");
      expect(result.ok).toBe(false);
    });

    it("rejects malformed JSON without throwing", () => {
      expect(() => parseEnvelope("{not json")).not.toThrow();
      expect(parseEnvelope("{not json").ok).toBe(false);
    });

    it("carries a well-formed git facet through when head and dirty are genuinely present", () => {
      const line =
        '{"v":1,"ts":"2026-07-14T10:00:00.000Z","event":{"hook_event_name":"SessionStart"},"git":{"head":"abc123","dirty":true}}';
      const result = parseEnvelope(line);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.git?.head).toBe("abc123");
        expect(result.git?.dirty).toBe(true);
      }
    });

    it("omits git entirely when the boundary line carries no git member", () => {
      const line = '{"v":1,"ts":"2026-07-14T10:00:00.000Z","event":{"hook_event_name":"PreToolUse"}}';
      const result = parseEnvelope(line);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.git).toBeUndefined();
      }
    });
  });

  describe("serializeEnvelope", () => {
    it("round-trips a simple payload via the decoded `event` field", () => {
      const ts = "2026-07-14T10:00:00.000Z";
      const result = serializeEnvelope({ v: 1, ts, event: { hook_event_name: "Stop" } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const parsed = parseEnvelope(result.line);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.ts).toBe(ts);
        expect(JSON.parse(parsed.eventText)).toEqual({ hook_event_name: "Stop" });
      }
    });

    it("embeds a pre-serialized eventText verbatim without re-encoding it", () => {
      const eventText = '{"zebra":1,"apple":"two"}';
      const result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", eventText });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const parsed = parseEnvelope(result.line);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.eventText).toBe(eventText);
      }
    });

    it("omits dirty when it is not a genuine boolean", () => {
      const result = serializeEnvelope({
        v: 1,
        ts: "2026-07-14T10:00:00.000Z",
        event: {},
        git: { head: "abc123", dirty: undefined },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const parsed = JSON.parse(result.line.trimEnd());
      expect(parsed.git).toEqual({ head: "abc123" });
    });

    it("omits the git member entirely when no field survives", () => {
      const result = serializeEnvelope({
        v: 1,
        ts: "2026-07-14T10:00:00.000Z",
        event: {},
        git: { head: "", dirty: undefined },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const parsed = JSON.parse(result.line.trimEnd());
      expect(parsed.git).toBeUndefined();
    });

    // F1 regression: raw stdin text (which the hook artifact is forbidden
    // from parsing) carries a trailing newline. Embedded unvalidated, this
    // used to write a two-physical-line record into the append-only spool
    // and desynchronize every subsequent line_no forever.
    it("rejects eventText with a trailing newline (raw stdin text) as a typed failure, never a multi-line write", () => {
      const eventText = '{"hook_event_name":"Stop"}\n';
      const result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", eventText });
      expect(result.ok).toBe(false);
    });

    it("rejects eventText with an interior newline as a typed failure", () => {
      const eventText = '{\n  "hook_event_name": "Stop"\n}';
      const result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", eventText });
      expect(result.ok).toBe(false);
    });

    it("rejects eventText containing raw control characters as a typed failure", () => {
      const eventText = '{"note":"a\tb"}';
      const result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", eventText });
      expect(result.ok).toBe(false);
    });

    it("rejects eventText that is not valid JSON as a typed failure", () => {
      const result = serializeEnvelope({
        v: 1,
        ts: "2026-07-14T10:00:00.000Z",
        eventText: "not json at all",
      });
      expect(result.ok).toBe(false);
    });

    it("rejects a decoded event of undefined as a typed failure rather than emitting the literal text `undefined`", () => {
      const result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", event: undefined });
      expect(result.ok).toBe(false);
    });

    // V2, 2026-07-14: serializeEnvelope is documented as never throwing, and
    // the decoded-value path still did for a BigInt, a circular reference,
    // and a throwing toJSON — JSON.stringify throws for each of those, and
    // the `=== undefined` guard alone catches none of them.
    it("returns a typed failure rather than throwing for a BigInt payload", () => {
      let result: ReturnType<typeof serializeEnvelope> | undefined;
      expect(() => {
        result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", event: { n: 1n } });
      }).not.toThrow();
      expect(result?.ok).toBe(false);
    });

    it("returns a typed failure rather than throwing for a circular object payload", () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      let result: ReturnType<typeof serializeEnvelope> | undefined;
      expect(() => {
        result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", event: circular });
      }).not.toThrow();
      expect(result?.ok).toBe(false);
    });

    it("returns a typed failure rather than throwing for a value whose toJSON throws", () => {
      const throwsOnEncode = {
        toJSON() {
          throw new Error("boom");
        },
      };
      let result: ReturnType<typeof serializeEnvelope> | undefined;
      expect(() => {
        result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", event: throwsOnEncode });
      }).not.toThrow();
      expect(result?.ok).toBe(false);
    });

    // The catch block itself must not throw. Reading the thrown value (String(err),
    // or err.message) re-throws when that value's toString/Symbol.toPrimitive/message
    // throws — the exception then escapes the function whose contract is "never throws".
    // Each payload below throws such a value out of JSON.stringify.
    it.each([
      [
        "a thrown value whose Symbol.toPrimitive throws",
        {
          toJSON() {
            throw {
              [Symbol.toPrimitive]() {
                throw new Error("toPrimitive boom");
              },
            };
          },
        },
      ],
      [
        "a thrown value whose toString throws",
        {
          toJSON() {
            throw {
              toString() {
                throw new Error("toString boom");
              },
            };
          },
        },
      ],
      [
        "a thrown Error whose message getter throws",
        {
          toJSON() {
            const err = new Error("x");
            Object.defineProperty(err, "message", {
              get() {
                throw new Error("message boom");
              },
            });
            throw err;
          },
        },
      ],
    ])("returns a typed failure rather than throwing for %s", (_label, event) => {
      let result: ReturnType<typeof serializeEnvelope> | undefined;
      expect(() => {
        result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", event });
      }).not.toThrow();
      expect(result?.ok).toBe(false);
    });

    // V3, 2026-07-14: eventText with leading/trailing whitespace was
    // accepted (JSON.parse tolerates it) but did not round-trip
    // byte-identically — the writer accepted bytes it could not give back.
    it("round-trips eventText with leading/trailing whitespace byte-identically (trimmed on write)", () => {
      const padded = '  {"a":1}  ';
      const result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", eventText: padded });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const parsed = parseEnvelope(result.line);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.eventText).toBe(padded.trim());
      // Re-serializing what came back must reproduce the same bytes again —
      // the definition of "round-trips byte-identically".
      const again = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", eventText: parsed.eventText });
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.line).toBe(result.line);
    });

    it("never emits more than one physical line for any accepted payload", () => {
      const payloads: unknown[] = [
        { a: 1 },
        { a: "line1\nline2" },
        { a: "\t\r control chars \x01" },
        [1, 2, 3],
        "a plain string",
        42,
        null,
      ];
      for (const event of payloads) {
        const result = serializeEnvelope({ v: 1, ts: "2026-07-14T10:00:00.000Z", event });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const withoutTrailingNewline = result.line.endsWith("\n")
          ? result.line.slice(0, -1)
          : result.line;
        expect(withoutTrailingNewline.includes("\n")).toBe(false);
        const parsed = parseEnvelope(result.line);
        expect(parsed.ok).toBe(true);
      }
    });
  });
});

import { describe, it, expect } from "vitest";
import path from "node:path";
import { SRC_CORE, tryImport } from "./helpers.js";

const ENVELOPE_MODULE = path.join(SRC_CORE, "envelope.ts");

describe("envelope", () => {
  it("parseEnvelope accepts a v1 envelope line and returns its ts and its event payload as the exact source text of the event member, byte-identical to the input slice; it rejects a line whose v is not 1, a line that is not JSON, and a line with no event member, returning a typed parse failure rather than throwing", async () => {
    const mod = await tryImport(ENVELOPE_MODULE);
    if (!mod) throw new Error("not implemented yet: src/core/envelope.ts");
    const { parseEnvelope } = mod;
    if (!parseEnvelope) throw new Error("not implemented yet: parseEnvelope export");

    // Odd key order / spacing in the event slice proves byte passthrough
    // rather than a decode-then-reserialize round trip.
    const eventSlice = '{"hook_event_name":"PreToolUse","z_key":1,"a_key":"two"}';
    const validLine = `{"v":1,"ts":"2026-07-14T10:00:00.000Z","event":${eventSlice}}`;

    const okResult = parseEnvelope(validLine);
    expect(okResult.ok).toBe(true);
    expect(okResult.envelope.ts).toBe("2026-07-14T10:00:00.000Z");
    expect(okResult.eventRaw).toBe(eventSlice);

    const badVersionResult = parseEnvelope(
      '{"v":2,"ts":"2026-07-14T10:00:00.000Z","event":{"a":1}}',
    );
    expect(badVersionResult.ok).toBe(false);

    const notJsonResult = parseEnvelope("this is not json at all");
    expect(notJsonResult.ok).toBe(false);

    const noEventResult = parseEnvelope('{"v":1,"ts":"2026-07-14T10:00:00.000Z"}');
    expect(noEventResult.ok).toBe(false);
  });
});

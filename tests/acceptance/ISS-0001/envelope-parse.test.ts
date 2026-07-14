import { describe, test, expect } from "vitest";

const MODULE_PATH = "../../../src/core/envelope";

async function loadEnvelopeModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

function callParseEnvelope(mod: any, line: string) {
  try {
    return { thrown: false as const, result: mod.parseEnvelope(line) };
  } catch (error) {
    return { thrown: true as const, error };
  }
}

describe("ISS-0001 core contracts: envelope parse", () => {
  test("parseEnvelope accepts a v1 envelope line and returns its ts, a decoded view of the event for field promotion, and the event payload as the exact source text of the event member, byte-identical to the input slice; it rejects a line whose v is not 1, a line that is not JSON, and a line with no event member, returning a typed parse failure rather than throwing.", async () => {
    const mod = await loadEnvelopeModule();
    if (!mod) throw new Error("src/core/envelope module not implemented yet");
    if (typeof mod.parseEnvelope !== "function") {
      throw new Error("src/core/envelope does not export parseEnvelope yet");
    }

    // A deliberately unsorted key order in the event member proves the
    // returned raw text is a byte-identical slice, not a re-serialization.
    const eventText = '{"hook_event_name":"PreToolUse","zebra":1,"apple":"two"}';
    const ts = "2026-07-14T10:00:00.000Z";
    const line = `{"v":1,"ts":"${ts}","event":${eventText}}`;

    const accepted = callParseEnvelope(mod, line);
    expect(accepted.thrown).toBe(false);
    const result = (accepted as any).result;
    expect(result?.ok).toBe(true);
    expect(result.ts).toBe(ts);
    // decoded view supports field promotion
    expect(result.event?.hook_event_name).toBe("PreToolUse");
    expect(result.event?.zebra).toBe(1);
    expect(result.event?.apple).toBe("two");
    // raw source text is byte-identical to the input slice, unsorted keys and all
    expect(result.eventText).toBe(eventText);

    // v is not 1
    const badVersion = callParseEnvelope(mod, `{"v":2,"ts":"${ts}","event":${eventText}}`);
    expect(badVersion.thrown).toBe(false);
    expect((badVersion as any).result?.ok).toBe(false);

    // not JSON at all
    const notJson = callParseEnvelope(mod, "this is not json { at all");
    expect(notJson.thrown).toBe(false);
    expect((notJson as any).result?.ok).toBe(false);

    // no event member
    const noEvent = callParseEnvelope(mod, `{"v":1,"ts":"${ts}"}`);
    expect(noEvent.thrown).toBe(false);
    expect((noEvent as any).result?.ok).toBe(false);
  });
});

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

describe("ISS-0001 core contracts: envelope git facet", () => {
  test("parseEnvelope does not blind-cast the git facet: a boundary line whose git.head is an empty string, null, or a non-string is a typed parse failure or yields an ABSENT head, never a fabricated value admitted into the typed contract.", async () => {
    const mod = await loadEnvelopeModule();
    if (!mod) throw new Error("src/core/envelope module not implemented yet");
    if (typeof mod.parseEnvelope !== "function") {
      throw new Error("src/core/envelope does not export parseEnvelope yet");
    }

    const ts = "2026-07-14T10:00:00.000Z";
    const eventText = '{"hook_event_name":"SessionStart"}';

    const cases = [
      `{"v":1,"ts":"${ts}","event":${eventText},"git":{"head":"","dirty":false}}`,
      `{"v":1,"ts":"${ts}","event":${eventText},"git":{"head":null,"dirty":false}}`,
      `{"v":1,"ts":"${ts}","event":${eventText},"git":{"head":12345,"dirty":false}}`,
    ];

    for (const line of cases) {
      const outcome = callParseEnvelope(mod, line);
      expect(outcome.thrown).toBe(false);
      const result = (outcome as any).result;
      // Either the whole line is rejected as a typed parse failure...
      if (result?.ok === false) {
        continue;
      }
      // ...or it is accepted, but the head facet must be genuinely absent,
      // never the fabricated empty-string/null/number value.
      expect(result?.ok).toBe(true);
      expect(result.git?.head).not.toBe("");
      expect(result.git?.head).not.toBe(null);
      expect(result.git?.head).not.toBe(12345);
      expect(result.git?.head).toBeUndefined();
    }
  });
});

import { describe, it, expect } from "vitest";
import { skillSource } from "../../../src/install/skillSource.js";

describe("install/skillSource", () => {
  it("returns a stable string, byte-identical across calls (no per-repo interpolation)", () => {
    expect(skillSource()).toBe(skillSource());
    expect(typeof skillSource()).toBe("string");
  });

  it("contains the cart check self-binding recipe, including the headless SessionStart read", () => {
    const text = skillSource();
    expect(text).toMatch(/cart check/);
    expect(text).toMatch(/--session/);
    expect(text).toMatch(/SessionStart/);
    expect(text).toMatch(/session_id/);
  });

  it("contains the never-edit / never-parse / never-fabricate rules", () => {
    const text = skillSource();
    expect(text).toMatch(/\.coreartifact\/\*\*/);
    expect(text.toLowerCase()).toMatch(/never edit/);
    expect(text.toLowerCase()).toMatch(/never parse/);
    expect(text).toMatch(/cart log/);
    expect(text).toMatch(/cart show/);
    expect(text.toLowerCase()).toMatch(/fabricat(e|ing)/);
  });

  it("contains the ABSENT-means-unverifiable-not-missing reading", () => {
    const text = skillSource();
    expect(text).toMatch(/ABSENT|‹absent›/);
    expect(text.toLowerCase()).toMatch(/unverifiable/);
  });

  it("has YAML frontmatter naming the skill and a triggering description", () => {
    const text = skillSource();
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/name:\s*coreartifact/);
    expect(text).toMatch(/description:.*verifiable/i);
  });
});

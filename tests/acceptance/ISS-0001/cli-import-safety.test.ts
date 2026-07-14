import { describe, test, expect } from "vitest";

// F4 regression: src/cli/index.ts used to call `main(process.argv.slice(2))`
// at module scope, and `main` calls `process.exit` on every path.
// Importing the built module therefore killed the importing process — a
// vitest worker that imports `main` or the command table would silently
// abort. The module must be safe to import: it must only invoke `main`
// when it is itself the process entry point (this test process is not).

describe("ISS-0001 core contracts: CLI module import safety", () => {
  test("importing the built CLI module does not invoke process.exit or otherwise kill the importing process", async () => {
    const mod = await import("../../../dist/cli/index.js");

    // Reaching this line at all is the primary assertion: if the module
    // still self-invoked `main` at import time, `process.exit` would have
    // terminated the whole vitest worker before this line ever ran.
    expect(typeof mod.main).toBe("function");
  });

  // V1, 2026-07-14: the command table must also be a public, importable
  // surface — later issues register `init`/`log`/`show`'s real handlers by
  // touching it, and later tests import it directly.
  test("importing the built CLI module also exports the command table naming init, log and show", async () => {
    const mod = await import("../../../dist/cli/index.js");
    expect(Array.isArray(mod.COMMANDS)).toBe(true);
    const names = (mod.COMMANDS as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["init", "log", "show"]));
  });
});

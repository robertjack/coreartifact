import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "./helpers.js";

describe("cli", () => {
  it("Running the built CLI entry with no arguments exits 0 and prints usage naming the commands init, log and show; running it with an unknown command exits nonzero and names the unknown command", () => {
    const noArgs = spawnSync("pnpm", ["exec", "cart"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(noArgs.status).toBe(0);
    const usageOutput = `${noArgs.stdout ?? ""}${noArgs.stderr ?? ""}`;
    expect(usageOutput).toMatch(/\binit\b/);
    expect(usageOutput).toMatch(/\blog\b/);
    expect(usageOutput).toMatch(/\bshow\b/);

    const unknownCommand = "totally-unknown-command";
    const badCommand = spawnSync("pnpm", ["exec", "cart", unknownCommand], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(badCommand.status).not.toBe(0);
    const badOutput = `${badCommand.stdout ?? ""}${badCommand.stderr ?? ""}`;
    expect(badOutput).toContain(unknownCommand);
  });
});

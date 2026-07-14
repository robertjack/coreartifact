import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const testDir = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");
const cliEntry = path.join(repoRoot, "dist", "cli", "bin.js");

describe("ISS-0001 core contracts: CLI skeleton", () => {
  test("Running the built CLI entry with no arguments exits 0 and prints usage naming the commands init, log and show; running it with an unknown command exits nonzero and names the unknown command.", () => {
    const noArgs = spawnSync("node", [cliEntry], { encoding: "utf8" });
    expect(noArgs.status).toBe(0);
    const usageOutput = `${noArgs.stdout ?? ""}${noArgs.stderr ?? ""}`;
    expect(usageOutput).toMatch(/\binit\b/);
    expect(usageOutput).toMatch(/\blog\b/);
    expect(usageOutput).toMatch(/\bshow\b/);

    const unknownCommand = "bogus-unknown-command";
    const badCommand = spawnSync("node", [cliEntry, unknownCommand], { encoding: "utf8" });
    expect(badCommand.status).not.toBe(0);
    const errorOutput = `${badCommand.stdout ?? ""}${badCommand.stderr ?? ""}`;
    expect(errorOutput).toContain(unknownCommand);
  });
});

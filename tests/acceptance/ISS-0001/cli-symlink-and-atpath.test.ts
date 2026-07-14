import { describe, test, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

// V1, 2026-07-14: the shipped `bin` used to guard `main()` behind an
// import.meta.url === toFileUrl(process.argv[1]) entrypoint check. That
// check reads false — and the CLI silently no-ops, exiting 0 and printing
// nothing, including for an unknown command — in the two layouts real
// installs actually use:
//   (a) invoked through a symlink (node_modules/.bin/coreartifact is a
//       symlink; ESM realpaths import.meta.url but not process.argv[1]);
//   (b) invoked from a path containing '@' (pnpm's store path is literally
//       `coreartifact@0.0.0`; the hand-rolled encodeURIComponent-based file
//       URL escaped '@', which Node's own pathToFileURL does not).
// No test exercised either layout before, because every test spawned
// dist/cli.js — the unguarded wrapper, not the guarded artifact `bin`
// actually named. The fix removed the guard entirely (src/cli/bin.ts is a
// pure entry, never imported), so there is nothing left to no-op; these
// tests exist to keep it that way.

const testDir = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");
const builtBin = path.join(repoRoot, "dist", "cli", "bin.js");

function assertUsageOnNoArgs(entry: string) {
  const noArgs = spawnSync("node", [entry], { encoding: "utf8" });
  expect(noArgs.status).toBe(0);
  const usageOutput = `${noArgs.stdout ?? ""}${noArgs.stderr ?? ""}`;
  expect(usageOutput).toMatch(/\binit\b/);
  expect(usageOutput).toMatch(/\blog\b/);
  expect(usageOutput).toMatch(/\bshow\b/);
}

function assertNonzeroOnUnknownCommand(entry: string) {
  const unknownCommand = "bogus-unknown-command";
  const badCommand = spawnSync("node", [entry, unknownCommand], { encoding: "utf8" });
  expect(badCommand.status).not.toBe(0);
  const errorOutput = `${badCommand.stdout ?? ""}${badCommand.stderr ?? ""}`;
  expect(errorOutput).toContain(unknownCommand);
}

describe("ISS-0001 core contracts: CLI skeleton via real install layouts", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const p = cleanupPaths.pop();
      if (p) fs.rmSync(p, { recursive: true, force: true });
    }
  });

  test("invoked through a symlink (node_modules/.bin install layout): usage on no args, nonzero+name on unknown command, never a silent exit 0", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coreartifact-symlink-"));
    cleanupPaths.push(tmpDir);
    const symlinkPath = path.join(tmpDir, "coreartifact");
    fs.symlinkSync(builtBin, symlinkPath);

    assertUsageOnNoArgs(symlinkPath);
    assertNonzeroOnUnknownCommand(symlinkPath);
  });

  test("invoked from a path containing '@' (pnpm store layout): usage on no args, nonzero+name on unknown command, never a silent exit 0", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coreartifact-atpath-"));
    cleanupPaths.push(tmpDir);
    const atDir = path.join(tmpDir, "coreartifact@0.0.0", "dist", "cli");
    fs.mkdirSync(atDir, { recursive: true });
    const distDir = path.join(repoRoot, "dist");
    // Copy the whole compiled dist tree so relative imports inside bin.js
    // (e.g. `./index.js`) still resolve from the new location.
    fs.cpSync(distDir, path.join(tmpDir, "coreartifact@0.0.0", "dist"), { recursive: true });
    const atPathEntry = path.join(tmpDir, "coreartifact@0.0.0", "dist", "cli", "bin.js");

    assertUsageOnNoArgs(atPathEntry);
    assertNonzeroOnUnknownCommand(atPathEntry);
  });
});

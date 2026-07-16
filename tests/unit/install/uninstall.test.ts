// Unit tests for the pieces of ISS-0022's uninstall that the acceptance
// seam (tests/acceptance/ISS-0022/uninstall.test.ts) cannot exercise:
//
//   - the TTY confirmation gate (`resolveConsent`), which the acceptance
//     harness cannot drive because runCli spawns with piped stdio, never a
//     PTY -- this issue's own Test-harness contract routes that path here,
//     with an injected is-TTY/answer seam instead of a real terminal.
//   - the install-backup manifest (`captureInstallBackup`/`readInstallBackup`),
//     the mechanism byte-identical restoration of a pre-existing
//     settings.local.json/.gitignore rests on -- worth proving directly
//     rather than only indirectly through the full CLI subprocess.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveConsent, type ConsentIO } from "../../../src/install/uninstall.js";
import { captureInstallBackup, readInstallBackup } from "../../../src/install/installBackup.js";

function fakeIO(overrides: Partial<ConsentIO> & { isTTY: boolean }): ConsentIO {
  return {
    write: () => {},
    readLine: async () => "",
    ...overrides,
  };
}

describe("install/uninstall resolveConsent (TTY confirmation gate)", () => {
  it("--yes proceeds without ever consulting isTTY or reading a line", async () => {
    const readLine = vi.fn(async () => "irrelevant");
    const io = fakeIO({ isTTY: false, readLine });
    const result = await resolveConsent(true, "inventory text", io);
    expect(result).toEqual({ proceed: true });
    expect(readLine).not.toHaveBeenCalled();
  });

  it("no --yes, no TTY: refuses, names --yes, and never reads a line (never hangs)", async () => {
    const readLine = vi.fn(async () => "yes");
    const io = fakeIO({ isTTY: false, readLine });
    const result = await resolveConsent(false, "inventory text", io);
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.reason).toContain("--yes");
    }
    expect(readLine).not.toHaveBeenCalled();
  });

  it("no --yes, TTY, answer 'yes': prints the full inventory first, then proceeds", async () => {
    const written: string[] = [];
    const io = fakeIO({
      isTTY: true,
      write: (chunk) => written.push(chunk),
      readLine: async () => "yes",
    });
    const result = await resolveConsent(false, "full inventory listing", io);
    expect(result).toEqual({ proceed: true });
    expect(written.join("")).toContain("full inventory listing");
  });

  it("no --yes, TTY, answer is not an explicit 'yes': aborts cleanly, no proceed", async () => {
    for (const answer of ["no", "", "y", "  Yes please  "]) {
      const io = fakeIO({ isTTY: true, readLine: async () => answer });
      const result = await resolveConsent(false, "inventory", io);
      expect(result.proceed, `answer ${JSON.stringify(answer)} must not proceed`).toBe(false);
    }
  });

  it("no --yes, TTY, answer 'yes' case/whitespace-insensitively: proceeds", async () => {
    for (const answer of ["yes", "YES", "  yes  ", "Yes"]) {
      const io = fakeIO({ isTTY: true, readLine: async () => answer });
      const result = await resolveConsent(false, "inventory", io);
      expect(result.proceed, `answer ${JSON.stringify(answer)} must proceed`).toBe(true);
    }
  });
});

describe("install/installBackup captureInstallBackup / readInstallBackup", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "iss22-installbackup-unit-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, ".gitkeep"), "");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("records existed:false for settings/gitignore paths that do not exist yet", () => {
    captureInstallBackup(repoRoot);
    const backup = readInstallBackup(repoRoot);
    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const gitignorePath = join(repoRoot, ".gitignore");
    expect(backup.entries[settingsPath]).toEqual({ existed: false });
    expect(backup.entries[gitignorePath]).toEqual({ existed: false });
  });

  it("captures the exact raw bytes of a pre-existing settings.local.json and .gitignore", () => {
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    const settingsBytes = '{"customUserKey":"keep-me-untouched","other":123}';
    const gitignoreBytes = "node_modules/\n*.log";
    writeFileSync(join(repoRoot, ".claude", "settings.local.json"), settingsBytes);
    writeFileSync(join(repoRoot, ".gitignore"), gitignoreBytes);

    captureInstallBackup(repoRoot);

    const backup = readInstallBackup(repoRoot);
    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const gitignorePath = join(repoRoot, ".gitignore");
    expect(backup.entries[settingsPath]).toEqual({ existed: true, content: settingsBytes });
    expect(backup.entries[gitignorePath]).toEqual({ existed: true, content: gitignoreBytes });
  });

  it("first capture wins: a second call does not clobber the true original with what's on disk now", () => {
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    const originalBytes = '{"original":true}';
    writeFileSync(join(repoRoot, ".claude", "settings.local.json"), originalBytes);

    captureInstallBackup(repoRoot);

    // Simulate init's own overwrite happening between two captureInstallBackup
    // calls (e.g. a second `init` run reusing the same call path).
    writeFileSync(join(repoRoot, ".claude", "settings.local.json"), '{"mutated":true,"hooks":{}}');
    captureInstallBackup(repoRoot);

    const backup = readInstallBackup(repoRoot);
    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    expect(backup.entries[settingsPath]).toEqual({ existed: true, content: originalBytes });
  });

  it("never touches disk for a repo root that does not exist (the fabricated paths hookConfig.test.ts uses)", () => {
    const fakeRoot = "/definitely/not/a/real/coreartifact/test/root";
    expect(existsSync(fakeRoot)).toBe(false);
    expect(() => captureInstallBackup(fakeRoot)).not.toThrow();
    expect(existsSync(fakeRoot)).toBe(false);
  });
});

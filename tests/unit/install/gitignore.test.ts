import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureGitignoreLines, linesInitAdded, removeGitignoreLines } from "../../../src/install/gitignore.js";

describe("install/gitignore", () => {
  let tmpDir: string;
  let gitignorePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss0005-gitignore-unit-"));
    gitignorePath = path.join(tmpDir, ".gitignore");
  });

  it("creates a missing .gitignore with the requested lines", () => {
    const changed = ensureGitignoreLines(gitignorePath, [".coreartifact/", ".claude/settings.local.json"]);
    expect(changed).toBe(true);
    const content = fs.readFileSync(gitignorePath, "utf8");
    expect(content).toContain(".coreartifact/");
    expect(content).toContain(".claude/settings.local.json");
  });

  it("is idempotent: calling it twice does not duplicate lines", () => {
    ensureGitignoreLines(gitignorePath, [".coreartifact/", ".claude/settings.local.json"]);
    const changedOnSecondCall = ensureGitignoreLines(gitignorePath, [
      ".coreartifact/",
      ".claude/settings.local.json",
    ]);
    expect(changedOnSecondCall).toBe(false);

    const lines = fs
      .readFileSync(gitignorePath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.filter((l) => l === ".coreartifact/")).toHaveLength(1);
    expect(lines.filter((l) => l === ".claude/settings.local.json")).toHaveLength(1);
  });

  it("appends to an existing .gitignore without disturbing the user's own entries, even when the file lacks a trailing newline", () => {
    fs.writeFileSync(gitignorePath, "node_modules\ndist/*.log", "utf8");
    const changed = ensureGitignoreLines(gitignorePath, [".coreartifact/"]);
    expect(changed).toBe(true);
    const content = fs.readFileSync(gitignorePath, "utf8");
    expect(content).toContain("node_modules");
    expect(content).toContain("dist/*.log");
    expect(content).toContain(".coreartifact/");
    // The pre-existing final line must not have been merged onto the same
    // physical line as the newly appended one.
    expect(content).not.toContain("dist/*.log.coreartifact/");
  });

  it("only appends the lines genuinely missing when some requested lines are already present", () => {
    fs.writeFileSync(gitignorePath, ".coreartifact/\n", "utf8");
    const changed = ensureGitignoreLines(gitignorePath, [".coreartifact/", ".claude/settings.local.json"]);
    expect(changed).toBe(true);
    const lines = fs
      .readFileSync(gitignorePath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.filter((l) => l === ".coreartifact/")).toHaveLength(1);
    expect(lines.filter((l) => l === ".claude/settings.local.json")).toHaveLength(1);
  });
});

// Reviewer finding F102 (round 2): the strip path (uninstall) must never
// remove a line just because it's on the static COREARTIFACT_GITIGNORE_LINES
// list -- only lines init itself actually added for THIS file, computed
// against that file's own pre-init content.
describe("install/gitignore linesInitAdded (F102: strip path must not delete user-owned lines)", () => {
  it("excludes a line the user's pre-init .gitignore already had, even though it's on the ensure list", () => {
    const preInit = ".coreartifact/\nnode_modules/\n";
    const added = linesInitAdded(preInit, [".coreartifact/", ".claude/settings.local.json"]);
    expect(added).toEqual([".claude/settings.local.json"]);
  });

  it("includes every line when none were present pre-init (fresh file)", () => {
    const added = linesInitAdded("", [".coreartifact/", ".claude/settings.local.json"]);
    expect(added).toEqual([".coreartifact/", ".claude/settings.local.json"]);
  });

  it("includes nothing when every line was already present pre-init", () => {
    const preInit = ".coreartifact/\n.claude/settings.local.json\n";
    const added = linesInitAdded(preInit, [".coreartifact/", ".claude/settings.local.json"]);
    expect(added).toEqual([]);
  });
});

describe("install/gitignore removeGitignoreLines (F102: exact-byte match, never trimmed)", () => {
  it("removes only lines that byte-match an entry in linesToRemove", () => {
    const content = ".coreartifact/\nnode_modules/\n";
    const result = removeGitignoreLines(content, [".coreartifact/"]);
    expect(result).toBe("node_modules/\n");
  });

  it("does not remove a user's own line that only trim-matches (leading/trailing whitespace)", () => {
    const content = "  .coreartifact/  \nnode_modules/\n";
    const result = removeGitignoreLines(content, [".coreartifact/"]);
    // The user's own whitespace-padded variant is not byte-identical to the
    // exact line init writes, so it must survive the strip untouched.
    expect(result).toBe("  .coreartifact/  \nnode_modules/\n");
  });
});

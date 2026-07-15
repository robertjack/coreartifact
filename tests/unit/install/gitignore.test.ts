import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureGitignoreLines } from "../../../src/install/gitignore.js";

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

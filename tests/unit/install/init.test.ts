// Unit coverage for src/install/init.ts's `installSkill` -- the worker both
// the real CLI (src/cli/commands/init.ts) and the acceptance test's
// standalone `init()` seam share (ISS-0034 rescue Ruling A). The acceptance
// suite (tests/acceptance/ISS-0034/init-skill.test.ts) already covers the
// install/uninstall/doctor round trip end to end; this file targets the one
// path that suite does not exercise directly: Ruling F's "never overwrite a
// pre-existing, non-canonical file at our path" skip.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, skillPathsFor } from "../../../src/install/init.js";
import { skillSource } from "../../../src/install/skillSource.js";
import { readInstallBackup } from "../../../src/install/installBackup.js";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cart-installskill-unit-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("install/init installSkill", () => {
  it("installs the canonical text, records it in the install backup, and ensures the gitignore line", () => {
    withTempDir((dir) => {
      const result = installSkill(dir);
      const { path: skillPath } = skillPathsFor(dir);
      expect(existsSync(skillPath)).toBe(true);
      expect(readFileSync(skillPath, "utf8")).toBe(skillSource());
      expect(result.message).toContain(skillPath);

      const backup = readInstallBackup(dir);
      expect(backup.entries[skillPath]).toBeDefined();
      expect(backup.entries[join(dir, ".gitignore")]).toBeDefined();
      expect(backup.entries[join(dir, ".claude", "skills")]).toEqual({ existed: false });

      const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(gitignore).toContain(".claude/skills/coreartifact/");
    });
  });

  it("skips (--no-skill) without touching disk or the install backup", () => {
    withTempDir((dir) => {
      const result = installSkill(dir, { noSkill: true });
      const { path: skillPath } = skillPathsFor(dir);
      expect(existsSync(skillPath)).toBe(false);
      expect(result.message.toLowerCase()).toMatch(/skip/);

      const backup = readInstallBackup(dir);
      expect(backup.entries[skillPath]).toBeUndefined();
    });
  });

  it("records .claude/skills as pre-existing when a sibling user-authored skill already created it", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".claude", "skills", "my-other-skill"), { recursive: true });
      writeFileSync(join(dir, ".claude", "skills", "my-other-skill", "SKILL.md"), "# mine\n");

      installSkill(dir);

      const backup = readInstallBackup(dir);
      expect(backup.entries[join(dir, ".claude", "skills")]).toEqual({ existed: true });
    });
  });

  // Ruling F (finding 203 S2): a pre-existing file at our exact path that is
  // NOT byte-identical to the canonical text must be left untouched, with a
  // printed warning naming it, and nothing recorded in the install backup
  // (so uninstall/doctor both stay silent about it -- Ruling C).
  it("Ruling F: skips install and warns, leaving a pre-existing non-canonical file untouched and unrecorded", () => {
    withTempDir((dir) => {
      const { dir: skillDir, path: skillPath } = skillPathsFor(dir);
      mkdirSync(skillDir, { recursive: true });
      const userContent = "# entirely user-authored, not the coreartifact skill\n";
      writeFileSync(skillPath, userContent);

      const result = installSkill(dir);

      expect(readFileSync(skillPath, "utf8")).toBe(userContent);
      expect(result.message.toLowerCase()).toMatch(/skip/);
      expect(result.message).toContain(skillPath);

      const backup = readInstallBackup(dir);
      expect(backup.entries[skillPath]).toBeUndefined();
      expect(backup.entries[join(dir, ".gitignore")]).toBeUndefined();
    });
  });

  // A pre-existing file at our path that HAPPENS to already be byte-identical
  // to the canonical text (e.g. a re-run after a prior install, or a repo
  // where a teammate committed the exact same bytes) is not a conflict --
  // installSkill proceeds normally (idempotent), recording it in the backup
  // as it would any fresh install.
  it("proceeds normally when the pre-existing file already matches the canonical text byte-for-byte", () => {
    withTempDir((dir) => {
      const { dir: skillDir, path: skillPath } = skillPathsFor(dir);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillPath, skillSource());

      const result = installSkill(dir);

      expect(result.message.toLowerCase()).not.toMatch(/skip/);
      const backup = readInstallBackup(dir);
      expect(backup.entries[skillPath]).toBeDefined();
    });
  });
});

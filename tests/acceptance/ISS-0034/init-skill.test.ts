import { describe, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// Built via .join('/') (not a string literal) so TypeScript does not attempt
// static module resolution on a file that does not exist yet — the dynamic
// import below is caught at runtime instead, giving an honest red today and
// the real module once the implementer creates it.
const INIT_MODULE = ["..", "..", "..", "src", "install", "init.ts"].join("/");
const UNINSTALL_MODULE = ["..", "..", "..", "src", "install", "uninstall.ts"].join("/");
const SKILL_SOURCE_MODULE = ["..", "..", "..", "src", "install", "skillSource.ts"].join("/");
const REPORT_MODULE = ["..", "..", "..", "src", "doctor", "report.ts"].join("/");

async function loadModule(path: string): Promise<any> {
  try {
    return await import(path);
  } catch {
    return undefined;
  }
}

async function loadInit() {
  const mod = await loadModule(INIT_MODULE);
  if (!mod) throw new Error("src/install/init.ts not implemented yet");
  const init = mod.init ?? mod.default;
  if (typeof init !== "function") throw new Error("init export not implemented yet");
  return init as (opts: Record<string, unknown>) => Promise<unknown> | unknown;
}

async function loadUninstall() {
  const mod = await loadModule(UNINSTALL_MODULE);
  if (!mod) throw new Error("src/install/uninstall.ts not implemented yet");
  const uninstall = mod.uninstall ?? mod.default;
  if (typeof uninstall !== "function") throw new Error("uninstall export not implemented yet");
  return uninstall as (opts: Record<string, unknown>) => Promise<unknown> | unknown;
}

async function loadSkillSource() {
  const mod = await loadModule(SKILL_SOURCE_MODULE);
  if (!mod) throw new Error("src/install/skillSource.ts not implemented yet");
  const skillSource = mod.skillSource ?? mod.default;
  if (typeof skillSource !== "function") throw new Error("skillSource export not implemented yet");
  return skillSource as () => string;
}

async function loadReport() {
  const mod = await loadModule(REPORT_MODULE);
  if (!mod) throw new Error("src/doctor/report.ts not implemented yet");
  const report = mod.report ?? mod.default;
  if (typeof report !== "function") throw new Error("report export not implemented yet");
  return report as (opts: Record<string, unknown>) => Promise<unknown> | unknown;
}

async function withTempRepo<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function snapshotTree(root: string): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Operator amendment 2026-07-21 (Ruling G's own sanction, re-review
        // Finding 1): record directory sentinels so the tree comparison sees
        // leftover EMPTY directories, mirroring ISS-0022/snapshotTree.ts.
        result[`${relative(root, full)}/`] = Buffer.from("<dir>");
        walk(full);
      } else {
        result[relative(root, full)] = readFileSync(full);
      }
    }
  }
  walk(root);
  return result;
}

const SKILL_REL_PATH = join(".claude", "skills", "coreartifact", "SKILL.md");

describe("ISS-0034: init installs a coreartifact SKILL.md", () => {
  it(
    "init installs .claude/skills/coreartifact/SKILL.md whose bytes equal the package's canonical skill source, records the file in the install backup, appends the skills path to the repo .gitignore via the existing ensureGitignoreLines path, and prints what it installed; init --no-skill installs everything else and no skill file, printing that the skill was skipped.",
    async () => {
      const init = await loadInit();
      const uninstall = await loadUninstall();
      const skillSource = await loadSkillSource();
      const canonicalText = skillSource();
      expect(typeof canonicalText).toBe("string");

      await withTempRepo("cart-iss0034-default-", async (repo) => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        let printedRaw: string;
        try {
          await init({ cwd: repo });
        } finally {
          // Operator amendment 2026-07-21 (Ruling B, finding 197): vitest 4
          // clears mock.calls on mockRestore — capture before restoring.
          printedRaw = logSpy.mock.calls.flat().join("\n");
          logSpy.mockRestore();
        }

        const skillPath = join(repo, SKILL_REL_PATH);
        expect(existsSync(skillPath)).toBe(true);
        expect(readFileSync(skillPath, "utf8")).toBe(canonicalText);

        const gitignorePath = join(repo, ".gitignore");
        expect(existsSync(gitignorePath)).toBe(true);
        const gitignoreContent = readFileSync(gitignorePath, "utf8");
        expect(gitignoreContent).toMatch(/\.claude\/skills/);

        const printed = printedRaw;
        expect(printed).toMatch(/skill/i);
        expect(printed).toMatch(/SKILL\.md|coreartifact\/skills|\.claude\/skills/);

        // Proof the install was recorded in the install backup: uninstall
        // must be able to find and remove exactly this file.
        await uninstall({ cwd: repo, yes: true });
        expect(existsSync(skillPath)).toBe(false);
      });

      await withTempRepo("cart-iss0034-noskill-", async (repo) => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        let printedRaw: string;
        try {
          await init({ cwd: repo, skill: false, noSkill: true });
        } finally {
          // Operator amendment 2026-07-21 (Ruling B, finding 197): as above.
          printedRaw = logSpy.mock.calls.flat().join("\n");
          logSpy.mockRestore();
        }

        const skillPath = join(repo, SKILL_REL_PATH);
        expect(existsSync(skillPath)).toBe(false);

        const printed = printedRaw;
        expect(printed.toLowerCase()).toMatch(/skip/);
        expect(printed.toLowerCase()).toMatch(/skill/);
      });
    },
  );

  it(
    "The canonical skill text (a versioned source in the package, resolved the hookArtifactSource way) contains, at minimum: the cart check self-binding recipe including the spool last-SessionStart id read for headless sessions; the never-edit .coreartifact/**, never-parse-spool/ledger-directly, never-fabricate-a-session-id rules; and the ABSENT-means-unverifiable-not-missing reading. The acceptance test asserts these by content, not by file size.",
    async () => {
      const skillSource = await loadSkillSource();
      const text = skillSource();
      expect(typeof text).toBe("string");

      // cart check self-binding recipe, including the headless SessionStart read.
      expect(text).toMatch(/cart check/);
      expect(text).toMatch(/--session/);
      expect(text).toMatch(/SessionStart/);
      expect(text).toMatch(/session_id/);

      // never-edit / never-parse / never-fabricate rules.
      expect(text).toMatch(/\.coreartifact\/\*\*/);
      expect(text.toLowerCase()).toMatch(/never edit/);
      expect(text.toLowerCase()).toMatch(/never parse/);
      expect(text).toMatch(/cart log/);
      expect(text).toMatch(/cart show/);
      expect(text.toLowerCase()).toMatch(/fabricat(e|ing)/);

      // ABSENT-means-unverifiable-not-missing reading.
      expect(text).toMatch(/ABSENT|‹absent›/);
      expect(text.toLowerCase()).toMatch(/unverifiable/);
    },
  );

  it(
    "uninstall removes exactly the skill file init installed (byte-identical inversion, ISS-0022 law): after init then uninstall --yes the repo tree matches its pre-init snapshot including the skills directory; a PRE-EXISTING .claude/skills/<other>/SKILL.md from the user survives both init and uninstall untouched.",
    async () => {
      const init = await loadInit();
      const uninstall = await loadUninstall();

      await withTempRepo("cart-iss0034-inversion-", async (repo) => {
        const otherSkillDir = join(repo, ".claude", "skills", "my-other-skill");
        mkdirSync(otherSkillDir, { recursive: true });
        const otherSkillPath = join(otherSkillDir, "SKILL.md");
        writeFileSync(otherSkillPath, "# my other skill\nuser-authored content\n");
        const otherSkillBytesBefore = readFileSync(otherSkillPath);

        const before = snapshotTree(repo);

        await init({ cwd: repo });

        expect(existsSync(join(repo, SKILL_REL_PATH))).toBe(true);
        expect(readFileSync(otherSkillPath)).toEqual(otherSkillBytesBefore);

        await uninstall({ cwd: repo, yes: true });

        expect(existsSync(otherSkillPath)).toBe(true);
        expect(readFileSync(otherSkillPath)).toEqual(otherSkillBytesBefore);

        const after = snapshotTree(repo);
        expect(after).toEqual(before);
      });
    },
  );

  it(
    "doctor reports a named finding when the installed skill's bytes differ from the running package's canonical text (the installBackup/drift pattern), and stays silent about the skill when they match or when no skill was installed.",
    async () => {
      const init = await loadInit();
      const report = await loadReport();

      await withTempRepo("cart-iss0034-doctor-match-", async (repo) => {
        await init({ cwd: repo });
        const findings = await report({ cwd: repo });
        const text = JSON.stringify(findings).toLowerCase();
        expect(text).not.toMatch(/skill/);
      });

      await withTempRepo("cart-iss0034-doctor-noskill-", async (repo) => {
        await init({ cwd: repo, skill: false, noSkill: true });
        const findings = await report({ cwd: repo });
        const text = JSON.stringify(findings).toLowerCase();
        expect(text).not.toMatch(/skill/);
      });

      await withTempRepo("cart-iss0034-doctor-drift-", async (repo) => {
        await init({ cwd: repo });
        const skillPath = join(repo, SKILL_REL_PATH);
        const original = readFileSync(skillPath, "utf8");
        writeFileSync(skillPath, original + "\nmutated-by-test\n");

        const findings = await report({ cwd: repo });
        const text = JSON.stringify(findings).toLowerCase();
        expect(text).toMatch(/skill/);
        expect(text).toMatch(/drift|differ|mismatch|changed|stale/);
      });
    },
  );

  it(
    "A repo that ran init before this feature (no skill recorded in its install backup) upgrades safely: uninstall does not attempt to remove a skill it never installed, and doctor does not flag its absence.",
    async () => {
      const init = await loadInit();
      const uninstall = await loadUninstall();
      const report = await loadReport();

      await withTempRepo("cart-iss0034-preexisting-", async (repo) => {
        // Simulates a repo installed before this feature shipped: no skill
        // file on disk and nothing about it recorded in the install backup.
        await init({ cwd: repo, skill: false, noSkill: true });
        expect(existsSync(join(repo, SKILL_REL_PATH))).toBe(false);

        let uninstallError: unknown = null;
        try {
          await uninstall({ cwd: repo, yes: true });
        } catch (err) {
          uninstallError = err;
        }
        expect(uninstallError).toBeNull();

        const findings = await report({ cwd: repo });
        const text = JSON.stringify(findings).toLowerCase();
        expect(text).not.toMatch(/skill/);
      });
    },
  );

  it("fresh repo, no sibling skills: init then uninstall inverts DIRECTORIES too — no empty .claude/ or .claude/skills/ left behind (operator amendment 2026-07-21, Ruling G / re-review Finding 1)", async () => {
    const init = await loadInit();
    const uninstall = await loadUninstall();
    await withTempRepo("cart-iss0034-freshdirs-", async (repo) => {
      const before = snapshotTree(repo);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await init({ cwd: repo });
      } finally {
        logSpy.mockRestore();
      }
      expect(existsSync(join(repo, SKILL_REL_PATH))).toBe(true);
      await uninstall({ cwd: repo, yes: true });
      expect(snapshotTree(repo)).toEqual(before);
      expect(existsSync(join(repo, ".claude"))).toBe(false);
    });
  });
});

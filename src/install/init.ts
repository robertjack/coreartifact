// Installs the coreartifact conventions skill into a repo (ISS-0034).
//
// Scope, per the issue's own Boundaries: install-surface only. This module
// never touches the hook artifact, the capture path, or ingest — those stay
// exactly where `coreartifact init` (src/cli/commands/init.ts) already
// implements them.
//
// `installSkill` is the pure(ish) worker both entry points below share:
// `src/cli/commands/init.ts`'s real `initCommand` flow (rescue rulings A/196
// — the skill install must be part of the actual CLI, not a parallel path
// nobody runs) calls it directly and folds its one-line message into its own
// `lines` array, exactly like every other install step; the standalone
// `init()` export below is kept ONLY because the locked acceptance test
// (tests/acceptance/ISS-0034/init-skill.test.ts) imports and calls it
// directly against a plain tmpdir (no git repo) — it is a thin
// console.log-and-delegate wrapper over the SAME worker, never a second
// implementation.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — every node:fs import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn, mkdirSync as mkdirSyncFn, readFileSync as readFileSyncFn, writeFileSync as writeFileSyncFn } from "node:fs";
import { joinPath } from "../core/paths.js";
import { skillSource } from "./skillSource.js";
import { ensureGitignoreLines, SKILL_GITIGNORE_LINE } from "./gitignore.js";
import { captureBackupEntry, captureBackupDirEntry, claudeDirBackupKey, skillsDirBackupKey } from "./installBackup.js";

const existsSync = existsSyncFn as (path: string) => boolean;
const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;
const writeFileSync = writeFileSyncFn as (path: string, data: string) => void;

export interface InitOptions {
  cwd: string;
  // `skill: false` and `noSkill: true` are the same request (the CLI's
  // `--no-skill` flag maps to `noSkill`); either is honored so a caller
  // never has to know which spelling the other one uses.
  skill?: boolean;
  noSkill?: boolean;
}

export interface SkillInstallResult {
  // A single line, in the same "label:  value" shape every other init step
  // prints, describing what happened (installed / skipped / skipped due to
  // a pre-existing conflicting file).
  message: string;
}

export function skillPathsFor(repoRoot: string): { dir: string; path: string } {
  const dir = joinPath(repoRoot, ".claude", "skills", "coreartifact");
  return { dir, path: joinPath(dir, "SKILL.md") };
}

// Installs (or, with --no-skill, deliberately skips) the skill for one
// repo. No consent question (spec ruling 1 — this is local-only guidance,
// nothing leaves the machine); loud by default, always describes the path.
export function installSkill(repoRoot: string, opts: { skill?: boolean; noSkill?: boolean } = {}): SkillInstallResult {
  const wantSkill = opts.noSkill !== true && opts.skill !== false;

  if (!wantSkill) {
    return { message: "skill:          skipped (--no-skill)" };
  }

  const { dir, path: skillPath } = skillPathsFor(repoRoot);
  const gitignorePath = joinPath(repoRoot, ".gitignore");

  // Ruling F (finding 203 S2): never overwrite a pre-existing file at our
  // path that is not itself the canonical skill text (the settings-merge
  // discipline — a pre-existing `.claude/skills/` directory is entered,
  // never clobbered). Nothing is recorded in the install backup for this
  // path, so uninstall and doctor both stay silent about it (Ruling C).
  if (existsSync(skillPath)) {
    const existing = readFileSync(skillPath, "utf8");
    if (existing !== skillSource()) {
      return {
        message: `skill:          skipped -- ${skillPath} already exists and is not the coreartifact skill (leaving it untouched)`,
      };
    }
  }

  // Capture pre-install bytes/absence for every path BEFORE writing
  // anything, so `uninstall` can invert byte-for-byte later (ISS-0022 law).
  // First-capture-wins: idempotent across a re-run, and shares the SAME
  // install-backup manifest the hook-config install path already uses.
  // The `.claude/skills` directory's own existence is captured too (Ruling
  // G): uninstall needs to know whether init's own install created that
  // parent directory before it can remove it as part of the inversion.
  // Re-review Finding 1 (2026-07-21): capture `.claude` too — first-capture-
  // wins, so in the real CLI flow the settings step's earlier record stands;
  // in the standalone seam THIS is what lets uninstall remove the empty
  // parent it created (full directory inversion, Ruling G).
  captureBackupDirEntry(repoRoot, claudeDirBackupKey(repoRoot));
  captureBackupDirEntry(repoRoot, skillsDirBackupKey(repoRoot));
  captureBackupEntry(repoRoot, skillPath);
  captureBackupEntry(repoRoot, gitignorePath);

  mkdirSync(dir, { recursive: true });
  writeFileSync(skillPath, skillSource());
  ensureGitignoreLines(gitignorePath, [SKILL_GITIGNORE_LINE]);

  return { message: `skill:          ${skillPath}` };
}

// Kept for the locked acceptance test's own import seam
// (tests/acceptance/ISS-0034/init-skill.test.ts calls `init` and `uninstall`
// directly against a plain tmpdir, never through git or the CLI). Delegates
// entirely to `installSkill` above — never a second implementation.
export async function init(opts: InitOptions): Promise<void> {
  const result = installSkill(opts.cwd, opts);
  console.log(result.message);
}

export default init;

// ISS-0009 acceptance test — packaging: the tarball, the two bins, and the
// npx path (docs/issues/ISS-0009.md).
//
// Test-harness contract: reuses the acceptance harness's tmpdir-repo factory
// (isolated HOME + registry) and its hermetic base env verbatim from
// ../harness/index.js, per the issue packet's "Test-harness contract"
// section. This is the one acceptance test in the whole suite that invokes
// the CLI through its INSTALLED bins rather than `runCli`'s `node dist/...`
// path (spec's own words: "this issue must not change" that separation for
// every other slice) — because the bins/npx path IS what this issue proves.
// Also imports src/core/paths.js's getPaths as an independent oracle for
// where the hook artifact lands post-init, exactly as ISS-0005/ISS-0007 do.
//
// The sole acceptance criterion is a compound: a `files` allowlist trims the
// tarball to runtime-only content, AND (unchanged by that field) the tarball
// still ships the built hook artifact + both bins, `init` from the installed
// package copies the artifact and exits 0, and `cart log` output is
// byte-identical to `coreartifact log`. All of that is asserted in the one
// test below, matching the packet's four-step recipe (pack, install into a
// separate tmpdir package, init against the installed bin, compare log
// output across both bins).
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpRepo, baseHermeticEnv, type TmpRepo } from "../harness/index.js";
import { getPaths } from "../../../src/core/paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

// The allowlist this issue's sole delta introduces: dist/ plus the metadata
// files npm/pnpm always include on top of an explicit `files` array.
const ALLOWED_TOP_LEVEL_METADATA_FILES = new Set([
  "package.json",
  "README.md",
  "README",
  "README.rst",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
]);

// Dev-only paths the packet explicitly names as excluded. Checked as a
// substring against the full tarball entry path (including the leading
// "package/" prefix npm/pnpm always add) rather than a prefix match, since
// several of these (CLAUDE.md, spec-v1.md, tsconfig.json) are top-level
// files, not directories.
const EXCLUDED_DEV_PATH_MARKERS = [
  "package/src/",
  "package/tests/",
  "package/docs/",
  "package/.aeh/",
  "package/.claude/",
  "package/CLAUDE.md",
  "package/spec-v1.md",
  "package/CONTEXT.md",
  "package/tsconfig.json",
];

function listTarballEntries(tgzPath: string): string[] {
  const output = execFileSync("tar", ["-tf", tgzPath], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim().replace(/\/$/, ""))
    .filter((line) => line.length > 0);
}

function readTarballFile(tgzPath: string, entryPath: string): string {
  return execFileSync("tar", ["-xOf", tgzPath, entryPath], { encoding: "utf8" });
}

describe("ISS-0009 packaging: the tarball, the two bins, and the npx path", () => {
  const cleanupDirs: string[] = [];
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "The tarball ships ONLY runtime files (dist/ plus package.json and README/LICENSE if present) via an explicit files allowlist - it does NOT ship src/, tests/, docs/, .aeh/, .claude/, CLAUDE.md, spec-v1.md, CONTEXT.md, tsconfig.json, or the fixture corpus. Asserted by enumerating the packed tarball's entries: every path is under package/dist/ or is one of the allowlisted top-level metadata files, and none is under the excluded dev directories. AND, unchanged by the files field: the tarball still contains the built hook artifact and both bins, init from the installed package copies the artifact and exits 0, and cart log output equals coreartifact log.",
    async () => {
      // Step 1: pnpm pack the repo into a tmpdir. globalSetup has already
      // built dist/ once in vitest's root process before any test file ran
      // (tests/acceptance/harness/globalSetup.ts), so this pack operates on
      // real built output, not stale or missing dist/. Lifecycle scripts are
      // ignored for exactly that reason: `prepack: pnpm run build` would
      // rewrite dist/ file-by-file WHILE concurrent workers import it — the
      // torn-dist flake (two field sightings, root-caused 2026-07-20; checks
      // 289 and 6311 in the live ledger).
      const packOutDir = mkdtempSync(join(tmpdir(), "coreartifact-pack-"));
      cleanupDirs.push(packOutDir);

      const packResult = spawnSync(
        "pnpm",
        ["pack", "--config.ignore-scripts=true", "--pack-destination", packOutDir],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
        },
      );
      expect(packResult.status, `pnpm pack failed: ${packResult.stderr}`).toBe(0);

      const tgzName = readdirSync(packOutDir).find((name) => name.endsWith(".tgz"));
      if (!tgzName) {
        throw new Error(`pnpm pack produced no .tgz in ${packOutDir}; stdout: ${packResult.stdout}`);
      }
      const tgzPath = join(packOutDir, tgzName);

      // Step 2 (files-allowlist half of the criterion): enumerate every
      // entry the tarball actually ships.
      const entries = listTarballEntries(tgzPath);
      expect(entries.length, "pnpm pack produced an empty tarball").toBeGreaterThan(0);

      for (const entry of entries) {
        if (entry === "package") continue; // the root package/ dir entry itself
        expect(entry.startsWith("package/"), `tarball entry outside package/: ${entry}`).toBe(true);

        const relPath = entry.slice("package/".length);
        if (relPath.length === 0) continue;

        const isUnderDist = relPath === "dist" || relPath.startsWith("dist/");
        const isAllowedMetadata = !relPath.includes("/") && ALLOWED_TOP_LEVEL_METADATA_FILES.has(relPath);
        expect(
          isUnderDist || isAllowedMetadata,
          `tarball ships a non-runtime path outside the files allowlist: ${entry}`,
        ).toBe(true);

        for (const marker of EXCLUDED_DEV_PATH_MARKERS) {
          expect(entry.startsWith(marker), `tarball ships an excluded dev path (${marker}): ${entry}`).toBe(false);
        }
      }

      // Step 2b (unchanged-by-files half): the built hook artifact and both
      // bins' entry file are still present, and package.json's bin wiring
      // for both names still points at it.
      expect(entries, "tarball no longer contains the built hook artifact").toContain("package/dist/hook/capture.js");
      expect(entries, "tarball no longer contains the CLI bin entry").toContain("package/dist/cli/bin.js");
      expect(entries, "tarball no longer contains package.json").toContain("package/package.json");

      const packedPkgJson = JSON.parse(readTarballFile(tgzPath, "package/package.json"));
      expect(packedPkgJson.bin, "packed package.json lost the coreartifact/cart bin wiring").toEqual({
        coreartifact: "dist/cli/bin.js",
        cart: "dist/cli/bin.js",
      });

      // Step 3: install the tarball into a SEPARATE tmpdir package, so the
      // bins land in that tmpdir's node_modules/.bin, exactly as an npx/npm
      // install consumer would receive them.
      const installDir = mkdtempSync(join(tmpdir(), "coreartifact-install-"));
      cleanupDirs.push(installDir);
      writeFileSync(
        join(installDir, "package.json"),
        JSON.stringify({ name: "coreartifact-install-target", version: "0.0.0", private: true }, null, 2),
      );

      const addResult = spawnSync("pnpm", ["add", tgzPath], { cwd: installDir, encoding: "utf8" });
      expect(addResult.status, `pnpm add of the packed tarball failed: ${addResult.stderr}`).toBe(0);

      const coreartifactBin = join(installDir, "node_modules", ".bin", "coreartifact");
      const cartBin = join(installDir, "node_modules", ".bin", "cart");
      expect(existsSync(coreartifactBin), "installed package did not expose a coreartifact bin").toBe(true);
      expect(existsSync(cartBin), "installed package did not expose a cart bin").toBe(true);

      // Step 4: create a tmpdir git repo via the harness factory, run the
      // installed coreartifact bin's init in it.
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const env = {
        ...baseHermeticEnv(repo.home),
        COREARTIFACT_REGISTRY_ROOT: dirname(repo.registryPath),
      };

      const initResult = spawnSync(coreartifactBin, ["init"], { cwd: repo.root, env, encoding: "utf8" });
      expect(initResult.status, `init from the installed package did not exit 0: ${initResult.stderr}`).toBe(0);

      const hookArtifactPath = getPaths(repo.root).hookArtifact;
      expect(
        existsSync(hookArtifactPath),
        "init from the installed package did not copy the hook artifact into the repo",
      ).toBe(true);

      // Run both coreartifact log and cart log from the installed bins
      // against the same repo; their stdout must be byte-identical.
      const logA = spawnSync(coreartifactBin, ["log"], { cwd: repo.root, env, encoding: "utf8" });
      const logB = spawnSync(cartBin, ["log"], { cwd: repo.root, env, encoding: "utf8" });
      expect(logA.status, `coreartifact log did not exit cleanly: ${logA.stderr}`).toBe(0);
      expect(logB.status, `cart log did not exit cleanly: ${logB.stderr}`).toBe(0);
      expect(logB.stdout, "cart log output was not byte-identical to coreartifact log output").toBe(logA.stdout);
    },
    120000,
  );
});

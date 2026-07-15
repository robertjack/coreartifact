// ISS-0009 acceptance tests — packaging: the tarball, the two bins, and the
// npx path (docs/issues/ISS-0009.md). Checked via pack + install into
// tmpdirs, never the live npm registry (issue's own words).
//
// Test-harness contract: reuses the acceptance harness's tmpdir-repo factory
// and isolated-HOME/registry primitives verbatim from ../harness/index.js.
// Also imports the already-shipped src/core/paths.js (getPaths) as an
// oracle for where the copied hook artifact must land — never guessed.
//
// Module under test: package.json's `bin`/`files`/build-before-pack wiring,
// which does not exist correctly yet (no `files` list, no prepack build
// step, and dist/ is .gitignore'd so a default `pnpm pack` omits it). These
// tests exercise the REAL packed tarball and the REAL installed bins as
// subprocesses — never CLI internals — so they fail red against the current
// package.json and pass once packaging is fixed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpRepo, baseHermeticEnv, type TmpRepo } from "../harness/index.js";
import { getPaths } from "../../../src/core/paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

interface RunBinResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunBinOptions {
  cwd: string;
  home: string;
  registryPath: string;
}

// Packs the repo (as it stands right now, uncommitted changes included —
// same "the tarball proves the tree" semantics `pnpm pack` always has) into
// `destDir` and returns the absolute path to the resulting tarball.
function packTarball(destDir: string): string {
  execFileSync("pnpm", ["pack", "--pack-destination", destDir], { cwd: REPO_ROOT });
  const tarballs = readdirSync(destDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `test setup invariant: expected exactly one .tgz in ${destDir} after pnpm pack, found: ${JSON.stringify(tarballs)}`,
    );
  }
  return join(destDir, tarballs[0]!);
}

// Lists the tarball's entry paths (each prefixed "package/", per npm/pnpm's
// own packing convention) without extracting it, so the hook-artifact
// criterion can be checked against the tarball's actual contents.
function listTarballEntries(tarballPath: string): string[] {
  const output = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Installs the tarball as a dependency of a brand-new, otherwise-empty
// tmpdir package — never the repo itself — so the bins that land under its
// node_modules/.bin are exactly what an end user's `npm install`/`npx`
// would produce, self-sufficient from the tarball alone.
function installTarball(tarballPath: string, home: string): { installDir: string; binDir: string } {
  const installDir = mkdtempSync(join(tmpdir(), "coreartifact-pack-install-"));
  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify({ name: "coreartifact-pack-install-target", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  execFileSync("pnpm", ["add", tarballPath], { cwd: installDir, env: baseHermeticEnv(home) });
  return { installDir, binDir: join(installDir, "node_modules", ".bin") };
}

// Runs an INSTALLED bin (not the harness's own `runCli`, which spawns the
// built entry by path via `node` — packaging's whole point is exercising
// the bin wiring itself) with the same hermetic, isolated-registry env the
// rest of the harness uses. Resolves rather than rejects on a spawn error
// (e.g. a dangling bin symlink whose target was never packed) so a broken
// bin surfaces as a clean assertion failure instead of an uncaught rejection.
function runInstalledBin(binPath: string, args: string[], options: RunBinOptions): Promise<RunBinResult> {
  const env: NodeJS.ProcessEnv = {
    ...baseHermeticEnv(options.home),
    COREARTIFACT_REGISTRY_ROOT: dirname(options.registryPath),
  };
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(binPath, args, { cwd: options.cwd, env });
    } catch (err) {
      resolvePromise({ exitCode: -1, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolvePromise({ exitCode: -1, stdout, stderr: `${stderr}\n${String(err)}` });
    });
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

describe("ISS-0009 packaging: the tarball, the two bins, and the npx path", () => {
  const tmpRepos: TmpRepo[] = [];
  // Cleanup tracks only directories that were actually created — a failure
  // partway through beforeAll (e.g. packing itself fails) must not turn a
  // legitimate red assertion into a second, unrelated crash in afterAll.
  const cleanupDirs: string[] = [];
  let tarballEntries: string[] = [];
  let binDir = "";

  beforeAll(async () => {
    const packDir = mkdtempSync(join(tmpdir(), "coreartifact-pack-"));
    cleanupDirs.push(packDir);
    const tarballPath = packTarball(packDir);
    tarballEntries = listTarballEntries(tarballPath);

    const installHome = mkdtempSync(join(tmpdir(), "coreartifact-pack-install-home-"));
    cleanupDirs.push(installHome);
    const installed = installTarball(tarballPath, installHome);
    cleanupDirs.push(installed.installDir);
    binDir = installed.binDir;
  }, 180000);

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "R13 Packaging. The packed tarball installs into a tmpdir and exposes bins coreartifact and cart; cart log output is identical to coreartifact log. (The npx path is checked via pack + install, not the live registry.)",
    async () => {
      const coreartifactBin = join(binDir, "coreartifact");
      const cartBin = join(binDir, "cart");
      expect(
        existsSync(coreartifactBin),
        `the installed package's node_modules/.bin has no "coreartifact" bin at ${coreartifactBin}`,
      ).toBe(true);
      expect(
        existsSync(cartBin),
        `the installed package's node_modules/.bin has no "cart" bin at ${cartBin}`,
      ).toBe(true);

      const repo = await createTmpRepo();
      tmpRepos.push(repo);

      const initResult = await runInstalledBin(coreartifactBin, ["init"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(
        initResult.exitCode,
        `installed "coreartifact init" did not exit 0; stderr: ${initResult.stderr}`,
      ).toBe(0);

      const coreartifactLog = await runInstalledBin(coreartifactBin, ["log"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      const cartLog = await runInstalledBin(cartBin, ["log"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });

      expect(
        coreartifactLog.exitCode,
        `installed "coreartifact log" did not exit 0; stderr: ${coreartifactLog.stderr}`,
      ).toBe(0);
      expect(cartLog.exitCode, `installed "cart log" did not exit 0; stderr: ${cartLog.stderr}`).toBe(0);
      expect(
        cartLog.stdout,
        "installed \"cart log\" stdout was not byte-identical to installed \"coreartifact log\" stdout",
      ).toBe(coreartifactLog.stdout);
    },
    180000,
  );

  it(
    "The packed tarball contains the built hook artifact, and init run from the installed package copies that artifact into the target repo and exits 0.",
    async () => {
      expect(
        tarballEntries.some((entry) => entry.endsWith("dist/hook/capture.js")),
        `the packed tarball did not contain the built hook artifact (expected an entry ending "dist/hook/capture.js"); entries: ${JSON.stringify(tarballEntries)}`,
      ).toBe(true);

      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const coreartifactBin = join(binDir, "coreartifact");

      const initResult = await runInstalledBin(coreartifactBin, ["init"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(
        initResult.exitCode,
        `init run from the installed package did not exit 0; stderr: ${initResult.stderr}`,
      ).toBe(0);

      const paths = getPaths(repo.root);
      expect(
        existsSync(paths.hookArtifact),
        `init run from the installed package did not copy the hook artifact into ${paths.hookArtifact}`,
      ).toBe(true);
    },
    180000,
  );
});

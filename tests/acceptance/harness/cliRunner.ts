// The CLI runner — primitive 2 of the acceptance harness (spec-v1.md "The
// acceptance harness", ISS-0003). Builds the CLI once per test run (a
// pre-step, memoized here, not repeated per test) and invokes the *built*
// entry as a subprocess via `node`, never an installed bin name — bins are
// the packaging slice's concern (spec's own words).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "bin.js");
const SRC_DIR = join(REPO_ROOT, "src");
const TSC_BIN = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

function isBuildFresh(): boolean {
  if (!existsSync(CLI_ENTRY)) return false;
  return statSync(CLI_ENTRY).mtimeMs >= newestMtime(SRC_DIR);
}

// Memoized across every runCli call in this module instance: "share the
// build, never the tmpdir" (spec's design constraints). Rebuilds only when
// dist/cli/bin.js is missing or older than the newest src file, so a fresh
// `pnpm test` (which already runs `pnpm build` first) never rebuilds twice.
let buildPromise: Promise<void> | undefined;

function ensureBuilt(): Promise<void> {
  if (!buildPromise) {
    buildPromise = Promise.resolve().then(() => {
      if (isBuildFresh()) return;
      execFileSync(process.execPath, [TSC_BIN], { cwd: REPO_ROOT, stdio: "ignore" });
    });
  }
  return buildPromise;
}

export interface RunCliOptions {
  cwd: string;
  home: string;
  registryPath: string;
}

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCli(args: string[], options: RunCliOptions): Promise<RunCliResult> {
  await ensureBuilt();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: options.home,
    // paths.ts reads this as the registry ROOT directory, not the log file
    // itself — see ISS-0001's paths.ts and its REGISTRY_ROOT_ENV_VAR.
    COREARTIFACT_REGISTRY_ROOT: dirname(options.registryPath),
  };

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd: options.cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

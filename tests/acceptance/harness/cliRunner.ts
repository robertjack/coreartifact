// The CLI runner — primitive 2 of the acceptance harness (spec-v1.md "The
// acceptance harness", ISS-0003). Invokes the *built* entry as a subprocess
// via `node`, never an installed bin name — bins are the packaging slice's
// concern (spec's own words).
//
// This module does NOT build the CLI itself (S1b fix, 2026-07-14
// escalation finding): the build happens exactly once, before vitest starts
// any worker, in tests/acceptance/harness/globalSetup.ts (wired via
// vitest.config.ts's `globalSetup`). A worker-local build memo here would
// only memoize per-worker, and vitest's default `forks` pool gives every
// test FILE its own worker process — so N test files would still race N
// concurrent `tsc` runs writing the same dist/. This runner instead
// verifies dist/ exists and fails loudly if it does not, rather than ever
// triggering a build itself.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseHermeticEnv } from "./env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "bin.js");

function assertBuilt(): void {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `runCli: CLI build not found at ${CLI_ENTRY}. The harness's globalSetup ` +
        "(tests/acceptance/harness/globalSetup.ts) is supposed to build the CLI " +
        "exactly once before any test runs — check that vitest.config.ts still " +
        "wires it as `globalSetup`, and that it ran successfully.",
    );
  }
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
  assertBuilt();

  // Same allowlisted base env the git invocations get (S2 fix, 2026-07-14
  // escalation finding) — the CLI subprocess must not inherit the
  // operator's ambient git-relevant env either, since it shells out to git
  // itself (src/core/attribution.ts).
  const env: NodeJS.ProcessEnv = {
    ...baseHermeticEnv(options.home),
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
    // Resolve on "close", not "exit": "exit" can fire while stdout/stderr still
    // have buffered data events pending, truncating captured output. Harmless
    // for the CLI skeleton's ~200-byte usage text, but this harness is copied
    // verbatim into seven slices that capture large ledger/timeline output where
    // the truncation is real (2026-07-14 review, advisory).
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

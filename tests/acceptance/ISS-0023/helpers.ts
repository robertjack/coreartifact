// ISS-0023 acceptance helpers — consent + the weekly ping.
//
// The packet's "Specifics the test-author must not go discover" section
// says the sink path must be "passed in the allowlisted child env (extend
// the harness runner's env parameter, not the allowlist default)". That
// extension target is ../harness/cliRunner.ts, but tests/acceptance/
// harness/** sits OUTSIDE this issue's writable footprint (tests/
// acceptance/ISS-0023/** only, enforced by a write-guard) — so the
// COREARTIFACT_PING_SINK plumbing lives in a local runner here instead,
// built from the SAME allowlist (../harness/env.js's baseHermeticEnv)
// rather than a denylist (docs/gotchas.md entry 3), never a fork of
// cliRunner.ts's own logic.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseHermeticEnv } from "../harness/env.js";
import { gitEnv } from "../harness/gitEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "bin.js");
export const HOOK_ARTIFACT_BUILD = join(REPO_ROOT, "dist", "hook", "capture.js");

function assertBuilt(entry: string): void {
  if (!existsSync(entry)) {
    throw new Error(
      `build not found at ${entry}. The harness's globalSetup ` +
        "(tests/acceptance/harness/globalSetup.ts) builds the CLI once before any " +
        "test runs — check that vitest.config.ts still wires it as globalSetup, and " +
        "that it ran successfully.",
    );
  }
}

export interface SpawnCliOptions {
  cwd: string;
  home: string;
  registryRoot: string;
  /** COREARTIFACT_PING_SINK — only set on the child env when provided. */
  sinkPath?: string;
}

export interface SpawnCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Spawns the built CLI entry (dist/cli/bin.js), same as ../harness/
 * cliRunner.ts's runCli, plus an optional COREARTIFACT_PING_SINK on the
 * child's allowlisted env — the acceptance seam for the injectable ping
 * transport (packet "The injectable transport"). */
export function spawnCli(args: string[], options: SpawnCliOptions): Promise<SpawnCliResult> {
  assertBuilt(CLI_ENTRY);
  const env: NodeJS.ProcessEnv = {
    ...baseHermeticEnv(options.home),
    COREARTIFACT_REGISTRY_ROOT: options.registryRoot,
  };
  if (options.sinkPath !== undefined) {
    env.COREARTIFACT_PING_SINK = options.sinkPath;
  }

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
    // Resolve on "close", matching cliRunner.ts's own rationale: "exit" can
    // fire while stdout/stderr still have buffered data events pending.
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/** Invokes the built hook artifact directly (dist/hook/capture.js), exactly
 * the way `init` installs it and a real hook config invokes it — the
 * acceptance seam for "the ping rides only the CLI entry, never the hook
 * artifact" (packet "Invariants"). */
export function spawnHookArtifact(
  initRoot: string,
  options: { home: string; registryRoot: string; sinkPath: string },
  stdinText: string,
): Promise<{ exitCode: number }> {
  assertBuilt(HOOK_ARTIFACT_BUILD);
  const env: NodeJS.ProcessEnv = {
    ...baseHermeticEnv(options.home),
    COREARTIFACT_REGISTRY_ROOT: options.registryRoot,
    COREARTIFACT_PING_SINK: options.sinkPath,
  };

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOOK_ARTIFACT_BUILD, initRoot], {
      env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ exitCode: code ?? -1 });
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** A second, independent git repo under the same tmpdir base and HOME as an
 * existing TmpRepo — the acceptance seam for "another repo, same machine"
 * (R10: subsequent inits in other repos do not re-ask). Mirrors ../harness/
 * tmpRepo.ts's own git-init sequence exactly, never forking it. */
export function createSiblingRepo(base: string, home: string): string {
  const root = join(base, "repo2");
  mkdirSync(root, { recursive: true });
  const env = gitEnv(home);
  execFileSync("git", ["init", "-q"], { cwd: root, env });
  execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: root, env });
  execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: root, env });
  writeFileSync(join(root, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: root, env });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: root, env });
  return root;
}

export interface SinkEntry {
  url?: unknown;
  payload?: unknown;
}

/** Reads the recording sink (packet: "appends `{url, payload}` as one JSON
 * line to that file"). A missing file is zero attempts, not an error. */
export function readSinkEntries(sinkPath: string): SinkEntry[] {
  if (!existsSync(sinkPath)) return [];
  const text = readFileSync(sinkPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SinkEntry);
}

export function countStateLines(statePath: string): number {
  if (!existsSync(statePath)) return 0;
  return readFileSync(statePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

// Independent source of truth for the ping payload's `version` field — read
// directly from package.json, never recomputed the way the ping module
// itself would compute it.
export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
).version;

// A generic RFC4122-shaped UUID check (no version/variant nibble pinned —
// the packet only promises "a random UUID", never a specific version).
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function tryImport(modulePath: string): Promise<any> {
  try {
    return await import(modulePath);
  } catch {
    return undefined;
  }
}

// `src/ping/**` is an owned glob, not a fixed filename (docs/issues/
// ISS-0023.md [files] owns) — several candidate layouts are tried rather
// than hard-guessing one path and permanently failing a correct-but-
// differently-laid-out implementation (gotchas entry 7: a guessed filename
// the footprint never granted has already caused two escalations).
export const PING_MODULE_CANDIDATES = [
  "../../../src/ping/index.js",
  "../../../src/ping/constants.js",
  "../../../src/ping/endpoint.js",
  "../../../src/ping/sender.js",
  "../../../src/ping/ping.js",
  "../../../src/ping/transport.js",
];

/** Best-effort resolver for a named export across several candidate module
 * paths/names. Returns undefined if nothing matches — callers must narrow
 * (throw) before use, per the packet's test-authoring instructions. */
export async function resolveNamedExport(candidatePaths: string[], exportNames: string[]): Promise<unknown> {
  for (const path of candidatePaths) {
    const mod = await tryImport(path);
    if (!mod) continue;
    for (const name of exportNames) {
      if (mod[name] !== undefined) return mod[name];
    }
  }
  return undefined;
}

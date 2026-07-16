import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as url from "node:url";
import { spawn } from "node:child_process";
import {
  tryImport,
  STATE_MODULE_PATH,
  PATHS_MODULE_PATH,
  INSTALL_WRITER_NAMES,
  resolveWriter,
  type ResolvedWriter,
} from "./helpers.js";

// Operator amendment 2026-07-16 (review-confirmed test bug): the real home
// must be captured at module load, BEFORE any beforeEach overrides HOME —
// os.homedir() reads process.env.HOME dynamically, so capturing it inside
// the test body compared the tmp override against itself.
const REAL_HOME_AT_LOAD = os.homedir();

// The state module (src/core/state.ts) does not exist yet. A top-level
// `import` of it would fail the whole file at collection, leaving every
// criterion unmapped instead of red — load it through a caught dynamic
// import instead (gotchas doc + packet instructions), and narrow the
// possibly-undefined result before use.
async function loadStateModule(): Promise<any> {
  const mod = await tryImport(STATE_MODULE_PATH);
  if (!mod || typeof mod.readState !== "function") {
    throw new Error(`not implemented yet: ${STATE_MODULE_PATH}#readState`);
  }
  return mod;
}

// paths.ts already exists (src/core/paths.ts, ISS-0001) — only the
// state-file field on its return value is new. A static top-level import
// would be safe here, but the dynamic form is used for consistency with the
// registry test suite's own style (tests/unit/core/registry.test.ts) and to
// keep every module load in this file going through one seam.
async function loadPathsModule(): Promise<any> {
  const mod = await tryImport(PATHS_MODULE_PATH);
  if (!mod || typeof mod.getPaths !== "function") {
    throw new Error(`not implemented yet: ${PATHS_MODULE_PATH}#getPaths`);
  }
  return mod;
}

// Spawn against the BUILT module (globalSetup runs `tsc` once before any
// worker forks — see tests/acceptance/harness/globalSetup.ts), the same way
// tests/acceptance/ISS-0010/registry.test.ts and
// tests/unit/core/registry.test.ts do: one separate OS process per append is
// the only honest way to exercise real O_APPEND interleaving (gotchas entry
// 4 — a Promise.all over an in-process synchronous body runs serially and
// cannot lose an update, so it cannot fail on the bug it exists to catch).
const testDir = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");
const distStateUrl = url.pathToFileURL(path.join(repoRoot, "dist", "core", "operatorState.js")).href;

function buildChildScript(writer: ResolvedWriter): string {
  if (writer.kind === "per-op") {
    return [
      `import * as mod from ${JSON.stringify(distStateUrl)};`,
      `await mod[${JSON.stringify(writer.name)}](process.env.CART_TEST_INSTALL_ID);`,
    ].join("\n");
  }
  // Generic single-writer shape: writer(op, fields).
  return [
    `import * as mod from ${JSON.stringify(distStateUrl)};`,
    `await mod[${JSON.stringify(writer.name)}]('install', { install_id: process.env.CART_TEST_INSTALL_ID });`,
  ].join("\n");
}

function spawnAppend(writer: ResolvedWriter, installId: string, childEnv: NodeJS.ProcessEnv): Promise<void> {
  const script = buildChildScript(writer);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...childEnv, CART_TEST_INSTALL_ID: installId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`child append for ${installId} exited ${code}: ${stderr}`));
      }
    });
  });
}

describe("ISS-0015 operator state", () => {
  let tmpHome: string;
  let tmpRegistryRoot: string;
  let originalHome: string | undefined;
  let originalRegistryRoot: string | undefined;
  const REGISTRY_ROOT_ENV_VAR = "COREARTIFACT_REGISTRY_ROOT";

  beforeEach(() => {
    // A unique mkdtemp per test, never a fixed name — collides on rerun
    // otherwise (packet's test-harness contract).
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss0015-state-"));
    tmpRegistryRoot = path.join(tmpHome, ".coreartifact");
    originalHome = process.env.HOME;
    originalRegistryRoot = process.env[REGISTRY_ROOT_ENV_VAR];
    // Overriding HOME alone is not sufficient: paths.ts gives
    // COREARTIFACT_REGISTRY_ROOT precedence over HOME, so on any machine
    // where that variable is already exported this suite would touch the
    // operator's REAL registry/state root unless the override itself is
    // set explicitly (same reasoning as tests/acceptance/ISS-0010/registry.test.ts).
    process.env.HOME = tmpHome;
    process.env[REGISTRY_ROOT_ENV_VAR] = tmpRegistryRoot;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRegistryRoot === undefined) {
      delete process.env[REGISTRY_ROOT_ENV_VAR];
    } else {
      process.env[REGISTRY_ROOT_ENV_VAR] = originalRegistryRoot;
    }
  });

  it(
    "Every operator-state change is one atomic O_APPEND of one line to the global state log: N concurrent state appends from N separate processes all survive in the log, no lock file is created anywhere, and nothing ever reads the file before writing it.",
    async () => {
      const mod = await loadStateModule();
      const writer = resolveWriter(mod, INSTALL_WRITER_NAMES, "install");
      if (!writer) {
        throw new Error(
          `not implemented yet: ${STATE_MODULE_PATH}#(no install writer found among ${INSTALL_WRITER_NAMES.join(", ")} or a generic writer)`
        );
      }

      const N = 16;
      const ids = Array.from({ length: N }, (_, i) => `concurrent-install-${i}`);

      // Build the child env from scratch (gotchas entry 3 — a denylist over
      // process.env still leaks XDG_CONFIG_HOME/GIT_* onto the operator's
      // machine): allowlist PATH/HOME/XDG_CONFIG_HOME via the harness's own
      // baseHermeticEnv, then add back only the registry-root override this
      // suite needs.
      const { baseHermeticEnv } = await import("../harness/env.js");
      const childEnv: NodeJS.ProcessEnv = {
        ...baseHermeticEnv(tmpHome),
        [REGISTRY_ROOT_ENV_VAR]: tmpRegistryRoot,
      };

      // N SEPARATE OS PROCESSES, not Promise.all over an in-process
      // synchronous body (gotchas entry 4) — this is the only way the lost
      // update this criterion guards against could actually manifest.
      await Promise.all(ids.map((id) => spawnAppend(writer, id, childEnv)));

      const stateFile = path.join(tmpRegistryRoot, "state.jsonl");
      expect(fs.existsSync(stateFile)).toBe(true);

      const lines = fs
        .readFileSync(stateFile, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(N);

      const parsed = lines.map((l) => JSON.parse(l));
      for (const entry of parsed) {
        expect(entry.op).toBe("install");
        expect(typeof entry.install_id).toBe("string");
      }
      const loggedIds = new Set(parsed.map((e) => e.install_id));
      for (const id of ids) {
        expect(loggedIds.has(id)).toBe(true);
      }

      // No lock file anywhere in the state directory: the observable proxy
      // this codebase already uses (tests/acceptance/ISS-0010/registry.test.ts)
      // for "never reads before writing" — a read-modify-write with a lock
      // would need one, an append-only O_APPEND never does.
      const filesInDir = fs.readdirSync(tmpRegistryRoot);
      expect(filesInDir.filter((f) => /lock/i.test(f))).toEqual([]);
    },
    20000
  );

  it("readState folds the log totally: install_id is the first install op's id (first-wins, stable forever), consent is the last consent op's ping value, last_ping_at is the latest ping op's timestamp; a missing file folds to the empty state, and a corrupt line, a truncated line, a line whose v is not 1 and a line with an unrecognized op are each skipped and counted, never thrown on.", async () => {
    const mod = await loadStateModule();
    const statePath = path.join(tmpRegistryRoot, "state.jsonl");

    // Missing file folds to the empty state, not an error.
    expect(fs.existsSync(statePath)).toBe(false);
    const missing = await mod.readState(statePath);
    expect(missing.install_id == null).toBe(true);
    expect(missing.consent).toBe(false);
    expect(missing.last_ping_at == null).toBe(true);
    expect(missing.skipped).toBe(0);

    fs.mkdirSync(path.dirname(statePath), { recursive: true });

    const at0 = new Date(0).toISOString();
    const at1 = new Date(1000).toISOString();
    const at2 = new Date(2000).toISOString();

    // Two valid lines per op (to prove first/last-wins), plus one example
    // each of: a corrupt line, a truncated line, a wrong-v line, and an
    // unrecognized-op line — four distinct hostile shapes, four skips.
    const lines = [
      JSON.stringify({ v: 1, op: "install", install_id: "first-install", at: at0 }),
      JSON.stringify({ v: 1, op: "install", install_id: "second-install-must-be-ignored", at: at1 }),
      JSON.stringify({ v: 1, op: "consent", ping: true, at: at0 }),
      JSON.stringify({ v: 1, op: "consent", ping: false, at: at1 }),
      JSON.stringify({ v: 1, op: "ping", at: at0 }),
      JSON.stringify({ v: 1, op: "ping", at: at2 }),
      "not even close to valid json {{{",
      '{"v":1,"op":"install","install_id":"cut-off-mid-object"',
      JSON.stringify({ v: 2, op: "install", install_id: "wrong-version", at: at0 }),
      JSON.stringify({ v: 1, op: "archive", at: at0 }),
    ];
    fs.writeFileSync(statePath, lines.join("\n") + "\n", "utf8");

    const folded = await mod.readState(statePath);

    // First-wins: the second install op must never overwrite the first.
    expect(folded.install_id).toBe("first-install");
    // Last-wins: the later consent op (false) overrides the earlier (true).
    expect(folded.consent).toBe(false);
    // Latest ping timestamp survives, not the first or an arbitrary one.
    expect(folded.last_ping_at).toBe(at2);
    // Exactly 4 hostile lines: corrupt, truncated, wrong-v, unrecognized-op.
    expect(folded.skipped).toBe(4);
  });

  it("Consent silence folds to false: a state log with an install op but no consent op folds to consent off — the fold never fabricates a yes, and no default ever enables the ping.", async () => {
    const mod = await loadStateModule();
    const statePath = path.join(tmpRegistryRoot, "state.jsonl");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });

    const installOnly = JSON.stringify({
      v: 1,
      op: "install",
      install_id: "no-consent-ever-recorded",
      at: new Date(0).toISOString(),
    });
    fs.writeFileSync(statePath, `${installOnly}\n`, "utf8");

    const folded = await mod.readState(statePath);
    // The bug this guards against: defaulting silence to a flattering
    // "true" (or any truthy sentinel) rather than the degradation law's
    // "we don't know, so no".
    expect(folded.consent).toBe(false);
    expect(folded.install_id).toBe("no-consent-ever-recorded");
  });

  it("The state file lives under the same overridable global root as the registry, so a test subprocess never touches the operator's real home.", async () => {
    // Operator amendment 2 (2026-07-16, re-review S2): the override must
    // point at a root DISTINCT from this test's tmp HOME for the criterion
    // to be falsifiable — beforeEach roots the override inside tmpHome, so
    // a home-derived fallback path was byte-identical to the override path
    // and none of the assertions below could ever redden (gotchas entry 4).
    const distinctOverrideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss0015-override-"),
    );
    process.env[REGISTRY_ROOT_ENV_VAR] = distinctOverrideRoot;

    const pathsMod = await loadPathsModule();
    const paths = pathsMod.getPaths();

    const expectedRegistryRoot = distinctOverrideRoot;
    const expectedStatePath = path.join(expectedRegistryRoot, "state.jsonl");

    // The override variable (COREARTIFACT_REGISTRY_ROOT) is the SAME one
    // the registry already uses (paths.ts, REGISTRY_ROOT_ENV_VAR) — a
    // second, state-specific override would mean isolating a test
    // subprocess required setting two variables instead of one.
    expect(paths.registryRoot).toBe(expectedRegistryRoot);
    expect(typeof paths.state).toBe("string");
    expect(paths.state).toBe(expectedStatePath);

    // A home-derived fallback would land under tmpHome (this suite's HOME)
    // or under the real home captured at module load; the distinct
    // override root is under neither, so these genuinely discriminate.
    expect(paths.state.startsWith(tmpHome)).toBe(false);
    expect(paths.state.startsWith(REAL_HOME_AT_LOAD)).toBe(false);

    // End-to-end: reading state through the module under the override never
    // throws and never has to fall back to the real home to resolve a path.
    const stateMod = await loadStateModule();
    await expect(stateMod.readState()).resolves.toBeTruthy();

    fs.rmSync(distinctOverrideRoot, { recursive: true, force: true });
  });
});

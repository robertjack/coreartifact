import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as url from "node:url";
import { spawn } from "node:child_process";
import { appendInstall, appendConsent, appendPing, readState } from "../../../src/core/operatorState.js";

// Resolve the repo root the same way tests/unit/core/registry.test.ts does,
// so the concurrency test below can spawn against the built dist output
// (pnpm test always runs `pnpm build` first, via globalSetup).
const testDir = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");
const distStateUrl = url.pathToFileURL(path.join(repoRoot, "dist", "core", "operatorState.js")).href;

// One separate OS process per append — a Promise.all over an in-process
// synchronous body runs serially and cannot interleave, so it cannot fail
// on the very bug (a lost update) it exists to catch (gotchas entry 4).
function spawnAppendInstall(installId: string, statePath: string): Promise<void> {
  const script = [
    `import { appendInstall } from ${JSON.stringify(distStateUrl)};`,
    `await appendInstall(process.env.CART_TEST_INSTALL_ID, process.env.CART_TEST_STATE_PATH);`,
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, CART_TEST_INSTALL_ID: installId, CART_TEST_STATE_PATH: statePath },
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

describe("operatorState", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss0015-state-unit-"));
    statePath = path.join(tmpDir, "nested", "state.jsonl");
  });

  it("appendInstall creates the parent directory and appends exactly one JSONL line, never a lock file", async () => {
    expect(fs.existsSync(path.dirname(statePath))).toBe(false);

    await appendInstall("install-a", statePath);

    expect(fs.existsSync(statePath)).toBe(true);
    const lines = fs.readFileSync(statePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ v: 1, op: "install", install_id: "install-a" });

    const filesInDir = fs.readdirSync(path.dirname(statePath));
    expect(filesInDir.filter((f) => /lock/i.test(f))).toEqual([]);
  });

  it("appendConsent and appendPing append single well-formed lines", async () => {
    await appendConsent(true, statePath);
    await appendPing(statePath);

    const lines = fs.readFileSync(statePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ v: 1, op: "consent", ping: true });
    expect(JSON.parse(lines[1])).toMatchObject({ v: 1, op: "ping" });
  });

  it("N genuinely concurrent appendInstall calls from N SEPARATE PROCESSES yield a log whose fold contains all N ids, with no entry lost and no lock file", async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const N = 12;
    const ids = Array.from({ length: N }, (_, i) => `concurrent-unit-${i}`);

    await Promise.all(ids.map((id) => spawnAppendInstall(id, statePath)));

    const lines = fs.readFileSync(statePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(N);

    const filesInDir = fs.readdirSync(path.dirname(statePath));
    expect(filesInDir.filter((f) => /lock/i.test(f))).toEqual([]);

    const parsed = lines.map((l) => JSON.parse(l));
    const loggedIds = new Set(parsed.map((e) => e.install_id));
    for (const id of ids) {
      expect(loggedIds.has(id)).toBe(true);
    }
  }, 20000);

  it("readState folds a missing file to the empty state rather than throwing", async () => {
    expect(fs.existsSync(statePath)).toBe(false);
    const folded = await readState(statePath);
    expect(folded.install_id).toBeNull();
    expect(folded.consent).toBe(false);
    expect(folded.last_ping_at).toBeNull();
    expect(folded.skipped).toBe(0);
  });

  it("readState is first-wins for install_id, last-wins for consent and last_ping_at", async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const at0 = new Date(0).toISOString();
    const at1 = new Date(1000).toISOString();
    const at2 = new Date(2000).toISOString();

    await appendInstall("first", statePath);
    await appendInstall("second-must-be-ignored", statePath);
    fs.appendFileSync(statePath, `${JSON.stringify({ v: 1, op: "consent", ping: true, at: at0 })}\n`);
    fs.appendFileSync(statePath, `${JSON.stringify({ v: 1, op: "consent", ping: false, at: at1 })}\n`);
    fs.appendFileSync(statePath, `${JSON.stringify({ v: 1, op: "ping", at: at0 })}\n`);
    fs.appendFileSync(statePath, `${JSON.stringify({ v: 1, op: "ping", at: at2 })}\n`);

    const folded = await readState(statePath);
    expect(folded.install_id).toBe("first");
    expect(folded.consent).toBe(false);
    expect(folded.last_ping_at).toBe(at2);
    expect(folded.skipped).toBe(0);
  });

  it("consent silence folds to false: an install-only log never fabricates a yes", async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await appendInstall("no-consent-ever", statePath);

    const folded = await readState(statePath);
    expect(folded.consent).toBe(false);
    expect(folded.install_id).toBe("no-consent-ever");
  });

  it("readState skips-and-counts a corrupt line, a truncated line, a wrong-v line and an unrecognized op, never throwing", async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const at0 = new Date(0).toISOString();
    const lines = [
      JSON.stringify({ v: 1, op: "install", install_id: "valid", at: at0 }),
      "not even close to valid json {{{",
      '{"v":1,"op":"install","install_id":"cut-off-mid-object"',
      JSON.stringify({ v: 2, op: "install", install_id: "wrong-version", at: at0 }),
      JSON.stringify({ v: 1, op: "archive", at: at0 }),
    ];
    fs.writeFileSync(statePath, lines.join("\n") + "\n", "utf8");

    const folded = await readState(statePath);
    expect(folded.install_id).toBe("valid");
    expect(folded.skipped).toBe(4);
  });

  it("readState never throws on a line that is valid JSON but not an object (null, true, 123, a string, an array), and counts each as skipped", async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const valid = JSON.stringify({ v: 1, op: "install", install_id: "among-hostiles", at: new Date(0).toISOString() });
    const hostileLines = ["null", "true", "123", '"str"', "[]"];
    fs.writeFileSync(statePath, [valid, ...hostileLines].join("\n") + "\n", "utf8");

    const folded = await readState(statePath);
    expect(folded.install_id).toBe("among-hostiles");
    expect(folded.skipped).toBe(hostileLines.length);
  });

  it("readState skips-and-counts a line whose 'at' is absent rather than fabricating an empty-string timestamp", async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const missingAt = JSON.stringify({ v: 1, op: "install", install_id: "no-at" });
    fs.writeFileSync(statePath, `${missingAt}\n`, "utf8");

    const folded = await readState(statePath);
    expect(folded.install_id).toBeNull();
    expect(folded.skipped).toBe(1);
  });

  it("readState skips-and-counts a shape-invalid install (no install_id) rather than fabricating one", async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const noId = JSON.stringify({ v: 1, op: "install", at: new Date(0).toISOString() });
    fs.writeFileSync(statePath, `${noId}\n`, "utf8");

    const folded = await readState(statePath);
    expect(folded.install_id).toBeNull();
    expect(folded.skipped).toBe(1);
  });

  it("readState skips-and-counts a shape-invalid consent (ping not boolean) rather than coercing it", async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const badConsent = JSON.stringify({ v: 1, op: "consent", ping: "yes", at: new Date(0).toISOString() });
    fs.writeFileSync(statePath, `${badConsent}\n`, "utf8");

    const folded = await readState(statePath);
    expect(folded.consent).toBe(false);
    expect(folded.skipped).toBe(1);
  });

  it("readState folds a non-ENOENT read error on the file itself to an empty state with a warning, rather than rethrowing", async () => {
    // A directory at the state path causes EISDIR on read, not ENOENT.
    fs.mkdirSync(statePath, { recursive: true });

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const folded = await readState(statePath);
      expect(folded.install_id).toBeNull();
      expect(folded.skipped).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("readState reports zero skipped lines for a missing file or a clean log", async () => {
    const missing = await readState(statePath);
    expect(missing.skipped).toBe(0);

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await appendInstall("clean", statePath);
    const clean = await readState(statePath);
    expect(clean.skipped).toBe(0);
  });

  it("appendInstall defaults to the paths module's state location honoring the registry-root override", async () => {
    const { getPaths, REGISTRY_ROOT_ENV_VAR } = await import("../../../src/core/paths.js");
    const previous = process.env[REGISTRY_ROOT_ENV_VAR];
    process.env[REGISTRY_ROOT_ENV_VAR] = tmpDir;
    try {
      await appendInstall("default-path");
      const expectedPath = getPaths().state;
      expect(fs.existsSync(expectedPath)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env[REGISTRY_ROOT_ENV_VAR];
      } else {
        process.env[REGISTRY_ROOT_ENV_VAR] = previous;
      }
    }
  });
});

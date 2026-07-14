import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as url from "node:url";
import { spawn } from "node:child_process";
import { addLedger, readRegistry } from "../../../src/core/registry.js";

// Resolve the repo root the same way tests/acceptance/ISS-0001/cli.test.ts
// does, so the concurrency test below can spawn against the built dist
// output (pnpm test always runs `pnpm build` first).
const testDir = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");
const distRegistryUrl = url.pathToFileURL(path.join(repoRoot, "dist", "core", "registry.js")).href;

// Spawns one separate OS process that imports the *built* registry module
// and calls the real addLedger — this is the honest concurrency test: a
// Promise.all over an in-process synchronous body runs serially and cannot
// interleave, so it cannot fail on the very bug (a lost update) it exists
// to catch (2026-07-14 finding, R7). Separate processes are the real
// scenario this guards: parallel `init` runs across worktrees.
function spawnAppend(root: string, registryPath: string): Promise<void> {
  const script = [
    `import { addLedger } from ${JSON.stringify(distRegistryUrl)};`,
    `await addLedger(process.env.CART_TEST_ROOT, process.env.CART_TEST_REGISTRY);`,
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, CART_TEST_ROOT: root, CART_TEST_REGISTRY: registryPath },
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
        reject(new Error(`child append for ${root} exited ${code}: ${stderr}`));
      }
    });
  });
}

describe("registry", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss0010-registry-unit-"));
    registryPath = path.join(tmpDir, "nested", "registry.jsonl");
  });

  it("addLedger creates the parent directory and appends exactly one JSONL line, never a lock file", async () => {
    expect(fs.existsSync(path.dirname(registryPath))).toBe(false);

    await addLedger("/repo/a", registryPath);

    expect(fs.existsSync(registryPath)).toBe(true);
    const lines = fs.readFileSync(registryPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ v: 1, op: "add", repo_root: "/repo/a" });

    const filesInDir = fs.readdirSync(path.dirname(registryPath));
    expect(filesInDir.filter((f) => /lock/i.test(f))).toEqual([]);
  });

  it("N genuinely concurrent addLedger calls from N SEPARATE PROCESSES yield a log whose fold contains all N roots, with no entry lost and no lock file (Promise.all over an in-process synchronous body runs serially and cannot fail on a lost update, so it is not a real test of this)", async () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const N = 12;
    const roots = Array.from({ length: N }, (_, i) => `/repo/concurrent-proc-${i}`);

    // Fire all N child processes together; each does exactly one atomic
    // O_APPEND via the real addLedger, and genuinely runs as its own OS
    // process — the actual physics that makes the append race real.
    await Promise.all(roots.map((root) => spawnAppend(root, registryPath)));

    const lines = fs.readFileSync(registryPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(N);

    const filesInDir = fs.readdirSync(path.dirname(registryPath));
    expect(filesInDir.filter((f) => /lock/i.test(f))).toEqual([]);

    const folded = await readRegistry(registryPath);
    for (const root of roots) {
      expect(folded.has(root)).toBe(true);
    }
    expect(folded.size).toBe(N);
    expect(folded.skipped).toBe(0);
  }, 20000);

  it("readRegistry folds a missing file to the empty set rather than throwing", async () => {
    expect(fs.existsSync(registryPath)).toBe(false);
    const folded = await readRegistry(registryPath);
    expect(folded.size).toBe(0);
  });

  it("readRegistry skips a corrupt or truncated line, counts it as absent, and still returns every valid entry", async () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const validA = JSON.stringify({ v: 1, op: "add", repo_root: "/repo/valid-a", at: new Date(0).toISOString() });
    const validB = JSON.stringify({ v: 1, op: "add", repo_root: "/repo/valid-b", at: new Date(0).toISOString() });
    fs.writeFileSync(registryPath, [validA, "{ not valid json, truncated", validB].join("\n") + "\n", "utf8");

    const folded = await readRegistry(registryPath);
    expect(folded.size).toBe(2);
    expect(folded.has("/repo/valid-a")).toBe(true);
    expect(folded.has("/repo/valid-b")).toBe(true);
    expect(folded.skipped).toBe(1);
  });

  it("readRegistry counts every skipped line, not just the first, including malformed-but-parseable entries", async () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const valid = JSON.stringify({ v: 1, op: "add", repo_root: "/repo/only-valid", at: new Date(0).toISOString() });
    const malformedEntry = JSON.stringify({ v: 1, op: "add" }); // missing repo_root: parses, fails shape check
    fs.writeFileSync(
      registryPath,
      [valid, "{ not valid json", malformedEntry, "also not json }"].join("\n") + "\n",
      "utf8"
    );

    const folded = await readRegistry(registryPath);
    expect(folded.size).toBe(1);
    expect(folded.has("/repo/only-valid")).toBe(true);
    expect(folded.skipped).toBe(3);
  });

  it("readRegistry never throws on a line that is valid JSON but not an object (null, true, 123, a string, an array), and counts each as skipped", async () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const valid = JSON.stringify({ v: 1, op: "add", repo_root: "/repo/among-hostiles", at: new Date(0).toISOString() });
    const hostileLines = ["null", "true", "123", '"str"', "[]"];
    fs.writeFileSync(registryPath, [valid, ...hostileLines].join("\n") + "\n", "utf8");

    // The bug this guards: `typeof null === "object"` is the classic trap —
    // a naive `typeof parsed === "object"` guard lets `null` through and a
    // property access on it throws. Feed every hostile shape and assert no
    // throw and an exact skipped count, not just "did not crash".
    const folded = await readRegistry(registryPath);
    expect(folded.size).toBe(1);
    expect(folded.has("/repo/among-hostiles")).toBe(true);
    expect(folded.skipped).toBe(hostileLines.length);
  });

  it("readRegistry skips-and-counts a line whose 'at' is absent rather than fabricating an empty-string timestamp", async () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const missingAt = JSON.stringify({ v: 1, op: "add", repo_root: "/repo/no-at" });
    fs.writeFileSync(registryPath, `${missingAt}\n`, "utf8");

    const folded = await readRegistry(registryPath);
    // The bug this guards: a prior implementation defaulted the missing
    // `at` to "" and still registered the root. Fabricating a fact is the
    // failure — assert the root is dropped and counted, not merely that
    // `at` differs.
    expect(folded.has("/repo/no-at")).toBe(false);
    expect(folded.size).toBe(0);
    expect(folded.skipped).toBe(1);
  });

  it("readRegistry skips-and-counts a line whose v is not 1, never assuming v1", async () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const wrongVersion = JSON.stringify({ v: 2, op: "add", repo_root: "/repo/future-version", at: new Date(0).toISOString() });
    fs.writeFileSync(registryPath, `${wrongVersion}\n`, "utf8");

    const folded = await readRegistry(registryPath);
    expect(folded.has("/repo/future-version")).toBe(false);
    expect(folded.size).toBe(0);
    expect(folded.skipped).toBe(1);
  });

  it("readRegistry skips-and-counts an unrecognized op rather than folding it as an add", async () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const unknownOp = JSON.stringify({ v: 1, op: "archive", repo_root: "/repo/unknown-op", at: new Date(0).toISOString() });
    fs.writeFileSync(registryPath, `${unknownOp}\n`, "utf8");

    // The bug this guards: treating every non-"remove" op as an add. A
    // future 'remove' variant (e.g. a typo'd tombstone) must never silently
    // register a repo.
    const folded = await readRegistry(registryPath);
    expect(folded.has("/repo/unknown-op")).toBe(false);
    expect(folded.size).toBe(0);
    expect(folded.skipped).toBe(1);
  });

  it("readRegistry folds a non-ENOENT read error on the file itself to an empty set with a warning, rather than rethrowing", async () => {
    // A directory at the registry path causes EISDIR on read, not ENOENT —
    // the damaged-file case (permissions, EISDIR, ...) distinct from
    // missing-file.
    fs.mkdirSync(registryPath, { recursive: true });

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const folded = await readRegistry(registryPath);
      expect(folded.size).toBe(0);
      expect(folded.skipped).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("readRegistry reports zero skipped lines for a missing file or a clean log", async () => {
    const missing = await readRegistry(registryPath);
    expect(missing.skipped).toBe(0);

    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    await addLedger("/repo/clean", registryPath);
    const clean = await readRegistry(registryPath);
    expect(clean.skipped).toBe(0);
  });

  it("dedupes by repo_root: running addLedger twice for one repo appends two lines but folds to one entry", async () => {
    await addLedger("/repo/dup", registryPath);
    await addLedger("/repo/dup", registryPath);

    const lines = fs.readFileSync(registryPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);

    const folded = await readRegistry(registryPath);
    expect(folded.size).toBe(1);
    expect(folded.has("/repo/dup")).toBe(true);
  });

  it("a later remove op folds a repo_root out of the set without rewriting the log", async () => {
    await addLedger("/repo/removable", registryPath);
    fs.appendFileSync(
      registryPath,
      `${JSON.stringify({ v: 1, op: "remove", repo_root: "/repo/removable", at: new Date(0).toISOString() })}\n`
    );

    const folded = await readRegistry(registryPath);
    expect(folded.has("/repo/removable")).toBe(false);
  });

  it("addLedger defaults to the paths module's registry location honoring the registry-root override", async () => {
    const { getPaths, REGISTRY_ROOT_ENV_VAR } = await import("../../../src/core/paths.js");
    const previous = process.env[REGISTRY_ROOT_ENV_VAR];
    process.env[REGISTRY_ROOT_ENV_VAR] = tmpDir;
    try {
      await addLedger("/repo/default-path");
      const expectedPath = getPaths().registry;
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

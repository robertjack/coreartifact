import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { SRC_CORE, mkTmpDir, tryImport } from "./helpers.js";

const REGISTRY_MODULE = path.join(SRC_CORE, "registry.ts");
const PATHS_MODULE = path.join(SRC_CORE, "paths.ts");

// The spec requires the paths module to name an env var that overrides the
// registry location. We fetch the actual variable NAME from that module
// rather than hardcoding a guessed string, so the test only depends on the
// paths module exporting `REGISTRY_PATH_ENV_VAR`, not on us guessing its
// literal value.
async function setUpIsolatedRegistry() {
  const pathsMod = await tryImport(PATHS_MODULE);
  if (!pathsMod) throw new Error("not implemented yet: src/core/paths.ts");
  const envVarName = pathsMod.REGISTRY_PATH_ENV_VAR;
  if (!envVarName) {
    throw new Error(
      "not implemented yet: REGISTRY_PATH_ENV_VAR export from src/core/paths.ts",
    );
  }

  const dir = mkTmpDir("coreartifact-registry-");
  const registryPath = path.join(dir, "registry");
  const previous = process.env[envVarName];
  process.env[envVarName] = registryPath;
  return {
    registryPath,
    restore: () => {
      if (previous === undefined) delete process.env[envVarName];
      else process.env[envVarName] = previous;
    },
  };
}

describe("registry", () => {
  it("readRegistry on a missing registry file returns an empty ledger list rather than throwing; addLedger writes a v1 registry containing the repo root with an added-at timestamp, and calling addLedger again with the same repo root leaves exactly one entry for that root", async () => {
    const mod = await tryImport(REGISTRY_MODULE);
    if (!mod) throw new Error("not implemented yet: src/core/registry.ts");
    const { readRegistry, addLedger } = mod;
    if (!readRegistry || !addLedger) {
      throw new Error("not implemented yet: readRegistry/addLedger exports");
    }

    const { registryPath, restore } = await setUpIsolatedRegistry();
    try {
      expect(existsSync(registryPath)).toBe(false);
      const empty = await readRegistry();
      expect(empty.ledgers).toEqual([]);

      const repoRoot = "/tmp/some/fake/repo-root";
      await addLedger(repoRoot);

      const afterOne = await readRegistry();
      expect(afterOne.ledgers.length).toBe(1);
      expect(afterOne.ledgers[0].repo_root).toBe(repoRoot);
      expect(typeof afterOne.ledgers[0].added_at).toBe("string");
      expect(afterOne.ledgers[0].added_at.length).toBeGreaterThan(0);

      const onDiskRaw = JSON.parse(readFileSync(registryPath, "utf-8"));
      expect(onDiskRaw.v).toBe(1);

      await addLedger(repoRoot);
      const afterTwo = await readRegistry();
      const matching = afterTwo.ledgers.filter((l: any) => l.repo_root === repoRoot);
      expect(matching.length).toBe(1);
    } finally {
      restore();
    }
  });

  it("addLedger neither loses updates nor wedges: N concurrent addLedger calls with distinct repo roots leave all N entries in the registry, and an addLedger run against a stale lock left by a dead holder completes rather than failing permanently", async () => {
    const mod = await tryImport(REGISTRY_MODULE);
    if (!mod) throw new Error("not implemented yet: src/core/registry.ts");
    const { readRegistry, addLedger } = mod;
    if (!readRegistry || !addLedger) {
      throw new Error("not implemented yet: readRegistry/addLedger exports");
    }

    const concurrent = await setUpIsolatedRegistry();
    try {
      const N = 8;
      const roots = Array.from({ length: N }, (_, i) => `/tmp/concurrent-repo-${i}`);
      await Promise.all(roots.map((r) => addLedger(r)));

      const afterConcurrent = await readRegistry();
      for (const r of roots) {
        expect(afterConcurrent.ledgers.some((l: any) => l.repo_root === r)).toBe(true);
      }
      expect(afterConcurrent.ledgers.length).toBe(N);
    } finally {
      concurrent.restore();
    }

    const stale = await setUpIsolatedRegistry();
    try {
      // Seed a registry with one existing entry so the lock path is exercised.
      await addLedger("/tmp/pre-existing-repo");

      // spawnSync blocks until the child has exited, so by the time we read
      // its pid back the pid is already dead -- a guaranteed-stale holder,
      // with no race window.
      const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
      const lockPath = `${stale.registryPath}.lock`;
      writeFileSync(lockPath, String(deadPid));

      await addLedger("/tmp/after-stale-lock");
      const afterStale = await readRegistry();
      expect(
        afterStale.ledgers.some((l: any) => l.repo_root === "/tmp/after-stale-lock"),
      ).toBe(true);
    } finally {
      stale.restore();
    }
  });
});

// F119 (ISS-0017 round-2 review): concurrent `coreartifact check` runs
// against ONE repo must never die "database is locked" and zero evidence.
// Root cause (reviewer's executed repro, isolated on a scratch copy):
// src/ingest/index.ts opened its write transaction as plain `BEGIN`
// (DEFERRED) -- each concurrent ingest starts as a reader and upgrades to
// writer mid-transaction, and SQLite returns SQLITE_BUSY on THAT upgrade
// WITHOUT invoking the busy handler, so openLedger's busy_timeout never
// applies. `BEGIN IMMEDIATE` takes the write lock at transaction start,
// where busy_timeout DOES apply, so concurrent ingests serialize instead of
// erroring.
//
// This spawns >=10 SEPARATE `check` processes concurrently (docs/gotchas.md
// #4: real processes, not Promise.all over a synchronous body) against one
// repo -- the fleet workload the spec names ("Fleets use --session"). Every
// process must exit 0, and every one of the N check lines must land in the
// ledger with the exit code that process's own wrapped command produced.
import { describe, it, expect, afterAll } from "vitest";
import { createTmpRepo, runCli, type TmpRepo } from "../../acceptance/harness/index.js";
import { getPaths } from "../../../src/core/paths.js";
import { openLedger, type CheckRow } from "../../../src/core/ledger.js";

const CONCURRENCY = 10;

describe("concurrent check runs do not die 'database is locked'", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    `${CONCURRENCY} concurrent 'coreartifact check' processes against one repo all exit 0 and all record`,
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
      const init = await runCli(["init"], opts);
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          runCli(["check", `conc-${i}`, "--", "node", "-e", "process.exit(0)"], opts),
        ),
      );

      for (const [i, result] of results.entries()) {
        expect(
          result.exitCode,
          `check conc-${i} did not exit 0 (stderr: ${result.stderr})`,
        ).toBe(0);
        expect(
          result.stderr,
          `check conc-${i} must not surface a "database is locked" error`,
        ).not.toMatch(/database is locked/i);
      }

      const logResult = await runCli(["log"], opts);
      expect(logResult.exitCode, `log (ingest) did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const handle = openLedger(paths.ledger);
      let rows: CheckRow[];
      try {
        rows = handle.db.prepare("SELECT * FROM checks ORDER BY line_no").all() as CheckRow[];
      } finally {
        handle.close();
      }

      const names = new Set(rows.map((r) => r.name));
      for (let i = 0; i < CONCURRENCY; i++) {
        expect(names.has(`conc-${i}`), `no check row landed for conc-${i}`).toBe(true);
      }
      expect(rows.length, "every concurrent check must land exactly once").toBe(CONCURRENCY);
    },
    60000,
  );
});

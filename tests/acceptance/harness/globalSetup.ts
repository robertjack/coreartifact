// Global setup — runs once in vitest's ROOT process before any worker
// forks (S1b fix, 2026-07-14 escalation finding). Vitest's default `forks`
// pool gives each test FILE its own worker process; a module-level build
// memo inside cliRunner.ts only memoized per-worker, so N test files raced
// N concurrent `tsc` processes all writing the same dist/ — a build a
// worker cannot safely memoize across other workers. `globalSetup` runs
// exactly once, before any worker exists, so there is nothing to race.
//
// Rebuilds unconditionally rather than tracking freshness against `src/`
// alone (S3a finding): a `tsconfig.json` change, or a restored-older src
// file, would otherwise leave a freshness check watching only `src/` blind
// to a stale dist/. A single `tsc` run here is cheap enough that tracking
// partial freshness is not worth the risk of missing an input — "rebuild
// unconditionally in the pre-step" is the design constraint's own stated
// simplest option.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const TSC_BIN = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const VITE_BIN = join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");

export default function setup(): void {
  execFileSync(process.execPath, [TSC_BIN], { cwd: REPO_ROOT, stdio: "inherit" });
  // PRD-0003 (operator hand-edit at the plan gate, 2026-07-17): dashboard
  // acceptance tests spawn `open`, which serves the BUILT SPA assets — the
  // SPA build must exist before workers fork, for the same no-race reason
  // as the tsc build above. Conditional on the scaffold existing so this
  // is a no-op until ISS-0026 merges (and on machines without the web/
  // toolchain installed the guard keeps pre-dashboard suites green).
  if (existsSync(join(REPO_ROOT, "vite.config.ts")) && existsSync(VITE_BIN)) {
    execFileSync(process.execPath, [VITE_BIN, "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
}

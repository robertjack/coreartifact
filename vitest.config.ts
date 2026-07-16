import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Build the CLI exactly once, in vitest's root process, before any
    // worker forks (S1b, 2026-07-14 escalation finding). The default
    // `forks` pool gives each test FILE its own worker; a build triggered
    // from inside a worker (even memoized) only memoizes for that worker,
    // so N test files would race N concurrent `tsc` runs writing the same
    // dist/. globalSetup runs once, before any worker exists.
    globalSetup: ["tests/acceptance/harness/globalSetup.ts"],
    // The suite doubled during PRD-0002 (72 files; acceptance tests spawn
    // real subprocess CLIs and concurrent child fleets). Under the forks
    // pool's parallel load, the 5s default produced false-red timeouts on
    // tests that pass in isolation (operator fix 2026-07-16 post-ISS-0019
    // merge). 30s is headroom for contention, not license for slow tests.
    testTimeout: 30_000,
  },
});

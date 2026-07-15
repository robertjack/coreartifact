// The acceptance harness — one seam, four primitives, exported from one
// place (spec-v1.md "The acceptance harness", ISS-0003). Every later issue's
// Test-harness contract copies this directory verbatim; never re-derive it,
// never fork it.
export { createTmpRepo, type TmpRepo } from "./tmpRepo.js";
export { runCli, type RunCliOptions, type RunCliResult } from "./cliRunner.js";
export {
  replayFixtures,
  replayFixturesParallel,
  replayLines,
  type ReplayInvocation,
  type ReplayResult,
  type ParallelReplayRequest,
} from "./fixtureReplayer.js";
export { addWorktree, type Worktree } from "./worktree.js";
export { readSpool, readLedger, type LedgerSnapshot } from "./readers.js";
export { gitEnv } from "./gitEnv.js";
export { baseHermeticEnv } from "./env.js";

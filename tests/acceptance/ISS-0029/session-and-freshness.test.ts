// ISS-0029 acceptance tests — GET /api/session/<id>, the session view that
// mirrors `show`'s own derivation (docs/issues/ISS-0029.md, api.md Surface
// D), plus R5 (freshness + concurrency) and R8 (zero-footprint reads),
// exercised here because by this issue both /api/overview (ISS-0028) and
// /api/session/<id> exist and can be browsed together.
//
// Driven entirely over HTTP against the BUILT CLI as a real subprocess
// (`open --port 0 --no-browser`), mirroring ISS-0027/ISS-0028's own
// Test-harness contract precedent: this suite never imports the
// not-yet-existing src/dashboard/session.ts (or the routes.ts wiring)
// directly — the HTTP surface IS the seam api.md commits to.
//
// Seeding is real-path only: every session is replayed through the
// installed hook (the shared acceptance harness's replayLines), reusing
// ISS-0028's own seeding technique (kind mapping via source, real `check`
// binding while single-open, buildSubstitutedTranscript for a present-cost
// session, and the cwd/transcript_path pin for a replayed absolute-path
// fixture line — ISS-0028's own escalation-rescue fixture-pin note, reused
// here rather than re-derived).
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http, { type IncomingHttpHeaders } from "node:http";
import { createTmpRepo, runCli, replayLines, baseHermeticEnv, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { buildSubstitutedTranscript } from "../../fixtures/transcriptReplay.js";
import { getPaths } from "../../../src/core/paths.js";
import { KIND_ABSENCE_REASONS, COST_ABSENCE_REASONS } from "../../../src/core/absence.js";
import { snapshotTree, diffTreeSnapshots, type TreeSnapshot } from "../ISS-0022/snapshotTree.js";

// tests/acceptance/ISS-0029/session-and-freshness.test.ts -> repo root is
// three levels up (same depth as ISS-0027/ISS-0028's own files).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "bin.js");

function assertBuilt(): void {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI build not found at ${CLI_ENTRY}. The harness's globalSetup (tests/acceptance/harness/globalSetup.ts) ` +
        "is supposed to build it once before any test runs.",
    );
  }
}

interface HermeticEnvOptions {
  home: string;
  registryPath: string;
}

function envFor(options: HermeticEnvOptions): NodeJS.ProcessEnv {
  const base = baseHermeticEnv(options.home);
  return {
    ...base,
    COREARTIFACT_REGISTRY_ROOT: dirname(options.registryPath),
  };
}

interface SpawnedOpen {
  child: ChildProcess;
  url: string;
  stdout(): string;
  stderr(): string;
}

function spawnOpenAndWaitForUrl(cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<SpawnedOpen> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, "open", "--port", "0", "--no-browser"], { cwd, env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`open did not print a URL within ${timeoutMs}ms; stdout: ${stdout}; stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (settled) return;
      const match = stdout.match(/https?:\/\/\S+/);
      if (match) {
        settled = true;
        clearTimeout(timer);
        const url = match[0].replace(/[).,;'"]+$/, "");
        resolvePromise({ child, url, stdout: () => stdout, stderr: () => stderr });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`open exited (code ${code}) before printing a URL; stdout: ${stdout}; stderr: ${stderr}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  // Operator amendment 2026-07-17 (test_dispute repair): if the child has
  // already exited, 'exit' has already fired and Node never replays it —
  // attaching only a listener deadlocks the R7 test whenever the holder's
  // hold window elapses during the busy_timeout wait (deterministic 60s
  // timeout; executed root-cause in the implementer dossier). Guard on
  // exitCode/signalCode first; the listener covers the still-running case.
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    child.once("exit", () => resolvePromise());
  });
}

interface HttpJsonResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: any;
  rawBody: string;
}

function httpGetJson(baseUrl: string, path: string): Promise<HttpJsonResult> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(path, baseUrl);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: "GET", timeout: 10_000 },
      (res) => {
        let rawBody = "";
        res.on("data", (chunk) => (rawBody += chunk));
        res.on("end", () => {
          let body: any = undefined;
          try {
            body = JSON.parse(rawBody);
          } catch {
            body = undefined;
          }
          resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body, rawBody });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`request to ${target.toString()} timed out`)));
    req.end();
  });
}

// Overrides session_id on every raw hook-payload line of an already-loaded
// fixture stream -- cwd/transcript_path pinning is now the harness's own
// replayLines duty (ISS-0033); this file only ever needs the session_id
// override (and, in R2, a transcript_path override expressed through
// replayLines' own transcriptPathOverride option, never hand-rolled here).
// Mirrors ISS-0028/ISS-0032's own overrideSessionId precedent.
function overrideSessionId(rawLines: string[], sessionId: string): string[] {
  return rawLines.map((line) => JSON.stringify({ ...JSON.parse(line), session_id: sessionId }));
}

// A truncated (no SessionEnd) prefix of already-seeded lines -- leaves the
// session open so the single-open check-binding rule (ISS-0017 prior art,
// reused by ISS-0028's own Test-harness contract) binds a subsequently-run
// `check` to it.
function truncatedOpen(seededLines: string[]): string[] {
  return seededLines.slice(0, -1);
}

// Replays just the final (SessionEnd) line of already-seeded lines --
// closes a session previously opened via truncatedOpen.
async function closeSession(
  pinTarget: string,
  seededLines: string[],
  transcriptPathOverride?: string,
): Promise<void> {
  const last = seededLines[seededLines.length - 1]!;
  await replayLines([last], pinTarget, transcriptPathOverride !== undefined ? { transcriptPathOverride } : {});
}

// Recursively searches an arbitrary JSON value for a string that equals or
// contains `target` -- ISS-0028's own deepContainsValue helper, reused
// verbatim for the ambiguity error message's candidate-roots assertion,
// whose exact key shape api.md deliberately leaves to the implementer.
function deepContainsValue(value: unknown, target: string): boolean {
  if (typeof value === "string") return value === target || value.includes(target);
  if (typeof value === "number") return String(value) === target;
  if (Array.isArray(value)) return value.some((v) => deepContainsValue(v, target));
  if (value && typeof value === "object") return Object.values(value).some((v) => deepContainsValue(v, target));
  return false;
}

async function registerSecondRepo(primary: TmpRepo, second: TmpRepo): Promise<void> {
  const result = await runCli(["init"], { cwd: second.root, home: primary.home, registryPath: primary.registryPath });
  if (result.exitCode !== 0) {
    throw new Error(`test setup invariant: init of the second repo did not exit 0; stderr: ${result.stderr}`);
  }
}

// Spawns a SEPARATE process that opens the ledger read-write and holds a
// BEGIN IMMEDIATE write lock for `holdMs` -- the concurrency criterion's own
// "spawn a real concurrent writer" requirement (docs/gotchas.md #4: a
// Promise.all over a synchronous body runs serially in-process and can
// never produce the cross-process lock contention busy_timeout exists to
// absorb). Reports "LOCKED" on stdout once the lock is actually held, so
// the caller never races the child's own node/sqlite startup latency.
function spawnLedgerHolder(ledgerPath: string, holdMs: number): Promise<ChildProcess> {
  const code = [
    'const { DatabaseSync } = require("node:sqlite");',
    "const path = process.argv[1];",
    "const holdMs = Number(process.argv[2]);",
    "const db = new DatabaseSync(path);",
    'db.exec("PRAGMA busy_timeout = 5000");',
    'db.exec("BEGIN EXCLUSIVE");',
    'process.stdout.write("LOCKED\\n");',
    'setTimeout(() => { db.exec("COMMIT"); db.close(); }, holdMs);',
  ].join("\n");

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["-e", code, ledgerPath, String(holdMs)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`ledger holder did not report LOCKED within timeout; stdout so far: ${stdout}`));
    }, 8_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!settled && stdout.includes("LOCKED")) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(child);
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function snapshotOutsideCoreartifact(root: string): TreeSnapshot {
  const full = snapshotTree(root);
  for (const key of [...full.keys()]) {
    if (key === ".coreartifact/" || key.startsWith(".coreartifact/")) full.delete(key);
  }
  return full;
}

describe("ISS-0029 GET /api/session/<id>: facets, checks, timeline, freshness, concurrency, zero-write", () => {
  const tmpRepos: TmpRepo[] = [];
  const liveChildren: ChildProcess[] = [];

  afterAll(async () => {
    for (const child of liveChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  async function makeRepo(): Promise<TmpRepo> {
    const repo = await createTmpRepo();
    tmpRepos.push(repo);
    return repo;
  }

  async function initRepo(repo: TmpRepo): Promise<void> {
    const result = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
    expect(result.exitCode, `test setup invariant: init did not exit 0; stderr: ${result.stderr}`).toBe(0);
  }

  async function openServerFor(home: string, registryPath: string, cwd: string): Promise<SpawnedOpen> {
    assertBuilt();
    const env = envFor({ home, registryPath });
    const opened = await spawnOpenAndWaitForUrl(cwd, env);
    liveChildren.push(opened.child);
    return opened;
  }

  async function stop(opened: SpawnedOpen): Promise<void> {
    opened.child.kill("SIGTERM");
    await waitForExit(opened.child);
  }

  it(
    "For a replayed fixture session, GET /api/session/<id> returns facets carrying session_id, repo_root, worktree_path, status, kind, sha_before, sha_after, model, cc_version, started_at, last_event_at, ended_at, plus cost as an object with value and derived true and tokens as an object with derived true and the four token counts.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);
      const sessionId = "iss29-r1-facets";

      // buildSubstitutedTranscript already rewrites transcript_path to a
      // tmpdir copy of the real cost-headless transcript; the harness's own
      // replayLines pins cwd to repo.root by construction (ISS-0033) and
      // the transcriptPathOverride option preserves the substituted copy.
      const { lines, transcriptPath } = buildSubstitutedTranscript("cost-headless", repo.root);
      const seeded = overrideSessionId(lines, sessionId);
      await replayLines(seeded, repo.root, { transcriptPathOverride: transcriptPath });

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const res = await httpGetJson(opened.url, `/api/session/${sessionId}`);
        expect(res.status, `GET /api/session/<id> did not return 200; body: ${res.rawBody}`).toBe(200);
        const facets = res.body?.facets;
        expect(facets, "response must carry a facets object").toBeTruthy();

        expect(facets.session_id, "facets.session_id must be the resolved full session id").toBe(sessionId);
        expect(facets.repo_root, "facets.repo_root must be the matched repo's root").toBe(repo.root);
        expect(facets.worktree_path, "facets.worktree_path must be null for the main checkout").toBe(null);
        expect(facets.status, "facets.status must be closed-clean for a session with a captured SessionEnd").toBe(
          "closed-clean",
        );
        expect(facets.kind, "facets.kind must be headless for a source:startup session").toBe("headless");
        expect("sha_before" in facets, "facets must carry the sha_before key").toBe(true);
        expect("sha_after" in facets, "facets must carry the sha_after key").toBe(true);
        expect(
          facets.sha_before === null || typeof facets.sha_before === "string",
          "facets.sha_before must be string|null",
        ).toBe(true);
        expect(
          facets.sha_after === null || typeof facets.sha_after === "string",
          "facets.sha_after must be string|null",
        ).toBe(true);
        expect(facets.model, "facets.model must be the transcript's recorded model").toBe("claude-fable-5");
        expect(facets.cc_version, "facets.cc_version must be the transcript's recorded claude code version").toBe(
          "2.1.211",
        );
        expect(typeof facets.started_at, "facets.started_at must be a string").toBe("string");
        expect(typeof facets.last_event_at, "facets.last_event_at must be a string").toBe("string");
        expect(typeof facets.ended_at, "facets.ended_at must be a non-null string for a closed-clean session").toBe(
          "string",
        );

        expect(facets.cost?.derived, "facets.cost.derived must be true").toBe(true);
        expect(facets.cost?.value, "facets.cost.value must equal the independently-known oracle total_cost_usd").toBeCloseTo(
          0.555957,
          6,
        );

        expect(facets.tokens?.derived, "facets.tokens.derived must be true").toBe(true);
        expect(facets.tokens?.input, "facets.tokens.input must equal the oracle's input_tokens").toBe(12);
        expect(facets.tokens?.output, "facets.tokens.output must equal the oracle's output_tokens").toBe(805);
        expect(facets.tokens?.cache_read, "facets.tokens.cache_read must equal the oracle's cache_read_input_tokens").toBe(
          166807,
        );
        expect(
          facets.tokens?.cache_creation,
          "facets.tokens.cache_creation must equal the oracle's cache_creation_input_tokens",
        ).toBe(17439);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "For the same session, GET /api/session/<id> returns checks as one entry per bound check with name, exit_code, passed, and truncated; test_results as the parser-derived facet; footprint as an array of touched paths; and absences as facet-and-reason entries copied from the ledger.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);
      const sessionId = "iss29-r2-checks-tests-footprint-absences";
      const footprintPath = join(repo.root, "iss29-footprint-note.txt");

      // Pin transcript_path to a definitely-nonexistent path: a deterministic
      // cost ABSENT with a real absences row ("transcript unavailable",
      // src/ingest/enrichment.ts) -- the same technique this criterion's
      // absences assertion needs, and independent from the facets test above
      // (which asserts the PRESENT-cost side of the same contract).
      const vitestLines = loadFixtureStream("vitest");
      const nonexistentTranscript = join(repo.root, "iss29-r2-no-such-transcript.jsonl");
      const seeded = overrideSessionId(vitestLines, sessionId);

      // Leave the session open (drop the final SessionEnd line) so the two
      // `check` invocations below bind via the single-open rule.
      await replayLines(truncatedOpen(seeded), repo.root, { transcriptPathOverride: nonexistentTranscript });

      const passingCheck = await runCli(["check", "iss29-c2-pass", "--", "node", "-e", "process.exit(0)"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(passingCheck.exitCode, "the passing check must exit 0").toBe(0);

      const failingCheck = await runCli(["check", "iss29-c2-fail", "--", "node", "-e", "process.exit(1)"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(failingCheck.exitCode, "the failing check must exit with the wrapped command's own code").toBe(1);

      // Hand-authored Write PreToolUse/PostToolUse events, replayed through
      // the real hook exactly like any other fixture line -- footprint is a
      // pure function of tool_name + tool_input.file_path
      // (src/ingest/footprint.ts), and no committed fixture in this repo
      // combines a file edit with a vitest test command in one stream.
      const writeToolUseId = "iss29-r2-write";
      const preWrite = {
        session_id: sessionId,
        cwd: repo.root,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: footprintPath, content: "iss29 footprint probe\n" },
        tool_use_id: writeToolUseId,
      };
      const postWrite = {
        ...preWrite,
        hook_event_name: "PostToolUse",
        tool_response: { type: "create", filePath: footprintPath, content: "iss29 footprint probe\n" },
        duration_ms: 5,
      };
      await replayLines([JSON.stringify(preWrite), JSON.stringify(postWrite)], repo.root, {
        transcriptPathOverride: nonexistentTranscript,
      });

      await closeSession(repo.root, seeded, nonexistentTranscript);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const res = await httpGetJson(opened.url, `/api/session/${sessionId}`);
        expect(res.status, `GET /api/session/<id> did not return 200; body: ${res.rawBody}`).toBe(200);

        const checks = res.body?.checks as Array<{ name: string; exit_code: number; passed: boolean; truncated: boolean }>;
        expect(Array.isArray(checks), "checks must be an array").toBe(true);
        expect(checks.length, "checks must carry exactly the two bound checks, never a standalone check").toBe(2);
        const pass = checks.find((c) => c.name === "iss29-c2-pass");
        const fail = checks.find((c) => c.name === "iss29-c2-fail");
        expect(pass, "the passing check must appear by name").toBeTruthy();
        expect(fail, "the failing check must appear by name").toBeTruthy();
        expect(pass?.exit_code, "the passing check's exit_code must be carried as 0").toBe(0);
        expect(pass?.passed, "the passing check's passed must be the derived render of exit_code == 0").toBe(true);
        expect(pass?.truncated, "the passing check's truncated must be false for short output").toBe(false);
        expect(fail?.exit_code, "the failing check's exit_code must be carried as 1").toBe(1);
        expect(fail?.passed, "the failing check's passed must be false for a nonzero exit_code").toBe(false);
        expect(fail?.truncated, "the failing check's truncated must be false for short output").toBe(false);

        const testResults = res.body?.test_results as Array<{
          passed: number;
          failed: number;
          skipped: number;
          duration_ms: number | null;
          failed_names: string[];
        }>;
        expect(Array.isArray(testResults), "test_results must be an array").toBe(true);
        expect(testResults.length, "test_results must carry exactly the two parser-claimed commands").toBe(2);

        const passingRun = testResults.find((r) => r.failed === 0);
        const failingRun = testResults.find((r) => r.failed > 0);
        expect(passingRun, "the passing vitest run must be present").toBeTruthy();
        expect(passingRun?.passed, "the passing run's passed count must match the fixture's own recorded summary").toBe(2);
        expect(passingRun?.skipped, "the passing run's skipped count must be a real zero").toBe(0);
        expect(
          passingRun?.duration_ms,
          "the passing run's duration_ms must match the fixture's own recorded Duration line",
        ).toBe(65);
        expect(passingRun?.failed_names, "the passing run's failed_names must be a real empty array").toEqual([]);

        expect(failingRun, "the failing vitest run must be present").toBeTruthy();
        expect(failingRun?.passed, "the failing run's passed count must match the fixture's own recorded summary").toBe(3);
        expect(failingRun?.failed, "the failing run's failed count must match the fixture's own recorded summary").toBe(1);
        expect(failingRun?.skipped, "the failing run's skipped count must be a real zero").toBe(0);
        expect(
          failingRun?.duration_ms,
          "the failing run's duration_ms must match the fixture's own recorded Duration line",
        ).toBe(74);
        expect(
          failingRun?.failed_names,
          "the failing run's failed_names must name the fixture's own recorded failing test",
        ).toEqual(["subtracts (deliberately red for the fixture)"]);

        expect(res.body?.footprint, "footprint must contain exactly the one distinct touched path").toEqual([
          footprintPath,
        ]);

        // Operator amendment 2026-07-17 (review S2 repair): the absences row
        // alone does not pin the facet VALUE — a handler fabricating $0 for
        // a cost-ABSENT session passed this test (mutation-proven by the
        // reviewer). B1 rule 2: null means ABSENT, never 0.
        expect(
          (res.body?.facets as { cost?: { value?: unknown; derived?: unknown } })?.cost?.value,
          "facets.cost.value must be null for a cost-ABSENT session — never a fabricated 0",
        ).toBeNull();
        expect(
          (res.body?.facets as { cost?: { derived?: unknown } })?.cost?.derived,
          "facets.cost.derived must remain true even when the value is ABSENT",
        ).toBe(true);
        expect(
          res.body?.absences,
          "absences must carry exactly the cost facet's transcript-unavailable reason, copied from the ledger",
        ).toEqual([{ facet: "cost", reason: COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE }]);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "For the same session, GET /api/session/<id> returns timeline in spool seq order where every entry carries prompt_id, agent_id, agent_type, and tool_use_id passed through with null where the event has none, and command entries carry a three-state outcome that stays absent for a backgrounded command with no resolving TaskOutput.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);

      // Session A: the full headless fixture (SubagentStart/Stop present) --
      // proves spool-seq ordering and the four nesting keys passed through
      // verbatim, null where the event has none.
      const sessionA = "iss29-r3-timeline-nesting";
      const headlessLines = loadFixtureStream("headless");
      await replayLines(overrideSessionId(headlessLines, sessionA), repo.root);

      // Session B: the background fixture, truncated to just the
      // backgrounding PostToolUse (no TaskOutput poll ever replayed) then
      // closed -- the backgrounded command has no resolving TaskOutput
      // anywhere in the session, so its outcome must stay absent, honestly.
      const sessionB = "iss29-r3-backgrounded-absent";
      const backgroundLines = loadFixtureStream("background");
      const seededB = overrideSessionId(backgroundLines, sessionB);
      await replayLines(seededB.slice(0, 4), repo.root);
      await closeSession(repo.root, seededB);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const resA = await httpGetJson(opened.url, `/api/session/${sessionA}`);
        expect(resA.status, `GET /api/session/<id> (session A) did not return 200; body: ${resA.rawBody}`).toBe(200);
        const timeline = resA.body?.timeline as Array<Record<string, unknown>>;
        expect(Array.isArray(timeline), "timeline must be an array").toBe(true);

        for (const entry of timeline) {
          expect("prompt_id" in entry, "every timeline entry must carry the prompt_id key").toBe(true);
          expect("agent_id" in entry, "every timeline entry must carry the agent_id key").toBe(true);
          expect("agent_type" in entry, "every timeline entry must carry the agent_type key").toBe(true);
          expect("tool_use_id" in entry, "every timeline entry must carry the tool_use_id key").toBe(true);
        }

        for (let i = 1; i < timeline.length; i++) {
          expect(
            (timeline[i - 1] as any).seq,
            "timeline entries must be in non-decreasing spool seq order",
          ).toBeLessThanOrEqual((timeline[i] as any).seq);
        }

        const sessionStart = timeline.find((e) => e.kind === "lifecycle" && e.hook_event_name === "SessionStart");
        expect(sessionStart, "a lifecycle SessionStart entry must be present").toBeTruthy();
        expect(sessionStart?.prompt_id, "SessionStart carries no prompt_id, so it must be null").toBe(null);
        expect(sessionStart?.agent_id, "SessionStart carries no agent_id, so it must be null").toBe(null);
        expect(sessionStart?.agent_type, "SessionStart carries no agent_type, so it must be null").toBe(null);
        expect(sessionStart?.tool_use_id, "SessionStart carries no tool_use_id, so it must be null").toBe(null);

        const promptEntry = timeline.find((e) => e.kind === "prompt");
        expect(promptEntry, "a prompt entry must be present").toBeTruthy();
        expect(
          promptEntry?.prompt_id,
          "the first UserPromptSubmit's prompt_id must be passed through verbatim",
        ).toBe("6216a674-57d8-4557-bad7-79b77859e074");

        const subagentStart = timeline.find((e) => e.kind === "subagent" && e.hook_event_name === "SubagentStart");
        expect(subagentStart, "a subagent SubagentStart entry must be present").toBeTruthy();
        expect(subagentStart?.agent_id, "SubagentStart's agent_id must be passed through verbatim").toBe(
          "ad8e71db58d6e5943",
        );
        expect(subagentStart?.agent_type, "SubagentStart's agent_type must be passed through verbatim").toBe(
          "general-purpose",
        );
        expect(subagentStart?.tool_use_id, "SubagentStart carries no tool_use_id, so it must be null").toBe(null);

        const subagentBashCommand = timeline.find((e) => e.tool_use_id === "toolu_01AVhFeLEhUaTpEwuYqdgsUv");
        expect(subagentBashCommand, "the subagent's own bash command entry must be present").toBeTruthy();
        expect(subagentBashCommand?.kind, "the subagent's bash command entry must be a command entry").toBe(
          "command",
        );
        expect(
          subagentBashCommand?.agent_id,
          "a command run inside the subagent must carry that subagent's agent_id",
        ).toBe("ad8e71db58d6e5943");

        const idxStart = timeline.indexOf(sessionStart!);
        const idxPrompt = timeline.indexOf(promptEntry!);
        const idxSubagentStart = timeline.indexOf(subagentStart!);
        const idxCommand = timeline.indexOf(subagentBashCommand!);
        expect(idxStart, "SessionStart must appear before the first prompt in spool order").toBeLessThan(idxPrompt);
        expect(idxPrompt, "the first prompt must appear before SubagentStart in spool order").toBeLessThan(
          idxSubagentStart,
        );
        expect(
          idxSubagentStart,
          "SubagentStart must appear before the subagent's own command in spool order",
        ).toBeLessThan(idxCommand);

        const resB = await httpGetJson(opened.url, `/api/session/${sessionB}`);
        expect(resB.status, `GET /api/session/<id> (session B) did not return 200; body: ${resB.rawBody}`).toBe(200);
        const timelineB = resB.body?.timeline as Array<Record<string, unknown>>;
        const backgroundedCommand = timelineB.find((e) => e.tool_use_id === "toolu_01XtAb6RzHiVjYLyasPc2cic");
        expect(backgroundedCommand, "the backgrounding command's own entry must be present").toBeTruthy();
        expect(backgroundedCommand?.kind, "the backgrounding command's entry must be a command entry").toBe(
          "command",
        );
        expect(
          backgroundedCommand?.outcome,
          "a backgrounded command with no resolving TaskOutput anywhere in the session must stay absent, never success",
        ).toEqual({ state: "absent" });
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "For a session whose kind is ABSENT, GET /api/session/<id> returns facets.kind as null and an absences entry for the kind facet with its recorded reason, and never renders the ABSENT facet as a zero or an omitted field.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);
      const sessionId = "iss29-r4-kind-absent";

      // "clear-source" is not one of the loader's typed ScenarioNames (it is
      // a hand-recorded edge-case fixture, not part of the recording-pass
      // manifest) -- read its raw lines directly, mirroring ISS-0028's own
      // loadRawFixtureLines helper for this exact file.
      const rawText = readFileSync(join(REPO_ROOT, "tests/fixtures/clear-source.jsonl"), "utf8");
      const rawLines = rawText.split("\n").filter((l) => l.trim().length > 0);
      await replayLines(overrideSessionId(rawLines, sessionId), repo.root);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const res = await httpGetJson(opened.url, `/api/session/${sessionId}`);
        expect(res.status, `GET /api/session/<id> did not return 200; body: ${res.rawBody}`).toBe(200);

        expect("kind" in (res.body?.facets ?? {}), "facets must carry the kind key, never omit it").toBe(true);
        expect(res.body?.facets?.kind, "facets.kind must be null for a kind-ABSENT session").toBe(null);
        expect(res.body?.facets?.kind, "facets.kind must never be rendered as a zero").not.toBe(0);

        expect(
          res.body?.absences,
          "absences must carry the kind facet's recorded reason, copied verbatim from the ledger",
        ).toContainEqual({
          facet: "kind",
          reason: KIND_ABSENCE_REASONS.MODEL_ABSENT_SOURCE_NOT_STARTUP_CLEAR,
        });
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "A GET /api/session/<id> for an id that matches no session in the union returns 404 with error code unknown_session naming the id, and a bare id that resolves in more than one repo returns 404 unknown_session stating it does not uniquely resolve and naming the candidate roots.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);
      await replayLines(overrideSessionId(loadFixtureStream("headless"), "iss29-r5-known-session"), repo.root);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const unknownId = "iss29-r5-totally-unknown-session-id";
        const notFoundRes = await httpGetJson(opened.url, `/api/session/${unknownId}`);
        expect(notFoundRes.status, "an unknown id must return 404").toBe(404);
        expect(notFoundRes.body?.error?.code, "the 404 error body code must be unknown_session").toBe(
          "unknown_session",
        );
        expect(
          deepContainsValue(notFoundRes.body, unknownId),
          "the 404 error must name the offending unknown id",
        ).toBe(true);
      } finally {
        await stop(opened);
      }

      // Ambiguity: the SAME session_id replayed into two separately
      // registered repos (resolveSession's own `ambiguous` case, api.md
      // Flag 2 -- the test harness itself replays one fixture stream into
      // two repos elsewhere for this exact purpose).
      const repoA = await makeRepo();
      await initRepo(repoA);
      const repoB = await makeRepo();
      await registerSecondRepo(repoA, repoB);

      const pathsA = getPaths(repoA.root);
      const pathsB = getPaths(repoB.root);

      const ambiguousId = "iss29-r5-ambiguous-session";
      const interactiveLines = loadFixtureStream("interactive");
      await replayLines(overrideSessionId(interactiveLines, ambiguousId), repoA.root);
      await replayLines(overrideSessionId(interactiveLines, ambiguousId), repoB.root);

      const openedAmbig = await openServerFor(repoA.home, repoA.registryPath, repoA.root);
      try {
        const res = await httpGetJson(openedAmbig.url, `/api/session/${ambiguousId}`);
        expect(res.status, "an ambiguous bare id must return 404, never a fourth status").toBe(404);
        expect(res.body?.error?.code, "the ambiguous case's error code must still be unknown_session").toBe(
          "unknown_session",
        );
        expect(
          String(res.body?.error?.message ?? "").toLowerCase(),
          "the ambiguous case's message must state the id does not uniquely resolve",
        ).toMatch(/uniquely resolve/);
        expect(deepContainsValue(res.body, repoA.root), "the ambiguous error must name the first candidate root").toBe(
          true,
        );
        expect(
          deepContainsValue(res.body, repoB.root),
          "the ambiguous error must name the second candidate root",
        ).toBe(true);
      } finally {
        await stop(openedAmbig);
      }
    },
    60_000,
  );

  it(
    "With the server running, appending a valid line to a registered repo's spool changes the very next GET /api/overview and the very next GET /api/session/<id> with no restart and no poll.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const before = await httpGetJson(opened.url, "/api/overview");
        expect(before.status, `initial GET /api/overview did not return 200; body: ${before.rawBody}`).toBe(200);
        expect(before.body?.sessions?.total, "sessions.total must be 0 before any session is seeded").toBe(0);

        const sessionId = "iss29-r6-freshness";
        await replayLines(overrideSessionId(loadFixtureStream("headless"), sessionId), repo.root);

        const afterOverview = await httpGetJson(opened.url, "/api/overview");
        expect(
          afterOverview.status,
          `GET /api/overview after appending a spool line did not return 200; body: ${afterOverview.rawBody}`,
        ).toBe(200);
        expect(
          afterOverview.body?.sessions?.total,
          "the very next GET /api/overview must reflect the newly appended session with no restart and no poll",
        ).toBe(1);
        const latestIds = (afterOverview.body?.sessions?.latest as Array<{ session_id: string }>).map(
          (s) => s.session_id,
        );
        expect(latestIds, "sessions.latest must include the newly appended session").toContain(sessionId);

        const afterSession = await httpGetJson(opened.url, `/api/session/${sessionId}`);
        expect(
          afterSession.status,
          `the very next GET /api/session/<id> did not return 200; body: ${afterSession.rawBody}`,
        ).toBe(200);
        expect(
          afterSession.body?.facets?.session_id,
          "the very next GET /api/session/<id> must resolve the newly appended session with no restart and no poll",
        ).toBe(sessionId);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "A GET completes without surfacing a database-is-locked error while a separate process concurrently holds the ledger during ingest, for both the overview and the session endpoint.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);
      const sessionId = "iss29-r7-concurrency";
      await replayLines(overrideSessionId(loadFixtureStream("headless"), sessionId), repo.root);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        // An uncontended round-trip first, so the ledger file already
        // exists (ingest-on-read creates it) before the holder opens it.
        const warm = await httpGetJson(opened.url, "/api/overview");
        expect(warm.status, "the warm-up GET /api/overview did not return 200").toBe(200);

        // Operator amendment 2026-07-17 (review S2 repair): with an
        // unchanged spool, the contended GET's ingest is a no-op and SQLite
        // readers never block on a RESERVED lock — the test passed with
        // busy_timeout deleted entirely (mutation-proven by the reviewer).
        // Append a second session's lines BEFORE the holder locks (spool
        // append is lazy; nothing projects until a GET), so the contended
        // GET's ingest-on-read MUST write the new projection under the
        // holder's BEGIN IMMEDIATE — busy_timeout is now load-bearing.
        const contendedId = "iss29-r7-contended";
        await replayLines(overrideSessionId(loadFixtureStream("headless"), contendedId), repo.root);

        const holdMs = 2_000;
        const holder = await spawnLedgerHolder(paths.ledger, holdMs);
        liveChildren.push(holder);

        const [overviewRes, sessionRes] = await Promise.all([
          httpGetJson(opened.url, "/api/overview"),
          httpGetJson(opened.url, `/api/session/${sessionId}`),
        ]);

        expect(
          overviewRes.body?.sessions?.total,
          "the contended GET must have ingested the pre-appended second session while the ledger was held — the write happened under contention, not skipped",
        ).toBe(2);

        expect(overviewRes.status, "GET /api/overview must complete (200) despite the concurrent ledger hold").toBe(
          200,
        );
        expect(
          overviewRes.rawBody.toLowerCase(),
          "GET /api/overview must never surface a database-is-locked error",
        ).not.toMatch(/database is locked/);

        expect(
          sessionRes.status,
          "GET /api/session/<id> must complete (200) despite the concurrent ledger hold",
        ).toBe(200);
        expect(
          sessionRes.rawBody.toLowerCase(),
          "GET /api/session/<id> must never surface a database-is-locked error",
        ).not.toMatch(/database is locked/);

        await waitForExit(holder);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "After coreartifact open followed by a full browse of the overview and a session view over HTTP, the repo tree outside .coreartifact/ is byte-identical to before and the registry log has not grown.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);
      const sessionId = "iss29-r8-zero-write";
      await replayLines(overrideSessionId(loadFixtureStream("headless"), sessionId), repo.root);

      const treeBefore = snapshotOutsideCoreartifact(repo.root);
      const registryBefore = existsSync(repo.registryPath) ? readFileSync(repo.registryPath) : Buffer.alloc(0);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const overviewRes = await httpGetJson(opened.url, "/api/overview");
        expect(overviewRes.status, "the browse's GET /api/overview did not return 200").toBe(200);
        const sessionRes = await httpGetJson(opened.url, `/api/session/${sessionId}`);
        expect(sessionRes.status, "the browse's GET /api/session/<id> did not return 200").toBe(200);
        // Operator amendment 2026-07-17 (test_author_defect repair): the
        // ISS-0027 route registry stubs /api/session/<id> as `200 {}`, so a
        // bare status assertion is green against today's tree and red-verify
        // rightly refused the criterion (mapped-but-green, twice). "A full
        // browse of ... a session view" means the REAL session view: pin the
        // body to the session it names — red against the stub's empty body,
        // green only when ISS-0029's handler exists.
        expect(
          (sessionRes.body as { facets?: { session_id?: unknown } }).facets?.session_id,
          "the browse's session GET must return the real session view naming the browsed session, not a stub body",
        ).toBe(sessionId);
      } finally {
        await stop(opened);
      }

      const treeAfter = snapshotOutsideCoreartifact(repo.root);
      const registryAfter = existsSync(repo.registryPath) ? readFileSync(repo.registryPath) : Buffer.alloc(0);

      const diffs = diffTreeSnapshots(treeBefore, treeAfter);
      expect(
        diffs,
        `the repo tree outside .coreartifact/ must be byte-identical after a full browse; diffs: ${diffs.join(", ")}`,
      ).toEqual([]);

      expect(
        registryAfter.length,
        "the registry log must not grow after a full browse over HTTP",
      ).toBeLessThanOrEqual(registryBefore.length);
      expect(
        registryAfter.equals(registryBefore),
        "the registry log's bytes must be unchanged after a full browse over HTTP",
      ).toBe(true);
    },
    60_000,
  );
});

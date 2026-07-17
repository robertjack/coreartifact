// ISS-0032 acceptance test -- the single browser-seam criterion (Testing
// decisions: "exactly one browser flow (R9)"), driving the REAL served UI
// end-to-end through the browser harness this issue also owns
// (./browser-harness.ts). Everything this flow depends on -- the server
// (ISS-0027), GET /api/overview (ISS-0028), the overview view (ISS-0030) and
// the session view (ISS-0031) -- already exists; the only thing missing at
// authoring time is playwright itself as a devDependency (package.json +
// pnpm-lock.yaml, this issue's own "touches"), which is why every test below
// currently fails red at the browser-harness's own not-yet-installed check
// rather than at collection.
//
// Seeding mirrors ISS-0028's overview.test.ts R1 seeding exactly (real
// fixture replay through the hook, real `check` binding for A/B), plus two
// hand-authored sessions in the same direct-spool-append style as that
// suite's own R5/R9 tests: a kind-ABSENT session (source "clear", demoted per
// the ISS-0025 kind-demote-only ruling) and an out-of-range-cc_version drift
// session (also source "clear", so it cannot perturb the delegated_total /
// headline math the way a fourth headless session would). Session A's own
// transcript_path is pinned to a path that cannot exist in this tmpdir
// (mirroring ISS-0028 R2's "absent-cost session" technique) so its cost
// facet is deterministically ABSENT with the recorded reason "transcript
// unavailable" (src/core/absence.ts's own closed vocabulary) -- the same
// Cost tile this test also asserts carries the derived marker satisfies both
// halves of criterion 2 at once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseHermeticEnv, createTmpRepo, replayLines, runCli, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { getPaths } from "../../../src/core/paths.js";
import { TESTED_CLAUDE_CODE_RANGE } from "../../../src/doctor/version.js";
import {
  captureScreenshot,
  closeSession as closeBrowserSession,
  gotoUrl,
  launchHeadlessSession,
  pageText,
  type BrowserSession,
} from "./browser-harness.js";

// tests/acceptance/ISS-0032/browser-flow.test.ts -> repo root is three
// levels up (same depth as ISS-0028's own overview.test.ts).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "bin.js");

const SESSION_A = "i32aaaaa-passing-check";
const SESSION_B = "i32bbbbb-failing-check";
const SESSION_C = "i32ccccc-no-checks";
const SESSION_D = "i32ddddd-interactive";
const SESSION_E = "i32eeeee-kind-absent";
const SESSION_F = "i32fffff-drift-session";
const DRIFT_VERSION = "2.1.220"; // well above TESTED_CLAUDE_CODE_RANGE.max (ISS-0028 R9 precedent)

function shortId(id: string): string {
  return id.slice(0, 8);
}

function assertBuilt(): void {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI build not found at ${CLI_ENTRY}. The harness's globalSetup (tests/acceptance/harness/globalSetup.ts) ` +
        "is supposed to build it once before any test runs.",
    );
  }
}

function envFor(options: { home: string; registryPath: string }): NodeJS.ProcessEnv {
  const base = baseHermeticEnv(options.home);
  return { ...base, COREARTIFACT_REGISTRY_ROOT: dirname(options.registryPath) };
}

interface SpawnedOpen {
  child: ChildProcess;
  url: string;
}

function spawnOpenAndWaitForUrl(cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<SpawnedOpen> {
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
        resolvePromise({ child, url });
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
  return new Promise((resolvePromise) => {
    child.on("exit", () => resolvePromise());
  });
}

function overrideSessionId(lines: string[], sessionId: string): string[] {
  return lines.map((line) => JSON.stringify({ ...JSON.parse(line), session_id: sessionId }));
}

// Pins cwd (and transcript_path, when present) to values under this test's
// own tmpdir -- the ISS-0028 R2 escalation's own fix: recorded streams carry
// absolute paths from the recording machine that can coincidentally exist on
// a dev machine running this suite, fabricating a present cost or attributing
// the session into a stale repo. Pinning makes the absence-or-presence
// deliberate rather than assumed.
function pinLine(line: string, cwd: string, transcriptPath: string): string {
  const obj = JSON.parse(line) as Record<string, unknown>;
  obj.cwd = cwd;
  if ("transcript_path" in obj) obj.transcript_path = transcriptPath;
  return JSON.stringify(obj);
}

function truncatedOpenLines(fullLines: string[]): string[] {
  return fullLines.slice(0, -1);
}

async function closeHookSession(hookCommand: string[], fullLines: string[]): Promise<void> {
  const last = fullLines[fullLines.length - 1]!;
  await replayLines([last], hookCommand);
}

// Hand-authors a minimal SessionStart-only envelope line and appends it
// directly to the repo's own spool -- the ISS-0028 packet's own sanctioned
// technique (its R5/R9 tests), reused here with a configurable `source` so
// this file can produce a kind-ABSENT session (source "clear", per the
// ISS-0025 kind-demote-only ruling) without going through the real hook.
function appendHandAuthoredSession(
  spoolPath: string,
  ts: string,
  sessionId: string,
  repoRoot: string,
  source: string,
  transcriptPath: string | null,
): void {
  const event: Record<string, unknown> = {
    session_id: sessionId,
    hook_event_name: "SessionStart",
    source,
    cwd: repoRoot,
  };
  if (transcriptPath !== null) event.transcript_path = transcriptPath;
  const line = `${JSON.stringify({ v: 1, ts, event })}\n`;
  appendFileSync(spoolPath, line);
}

interface FlowResult {
  overviewText: string;
  failingRowText: string;
  unknownRowText: string;
  screenshotPath: string;
  sessionAText: string;
  sessionAAbsentSummaryCount: number;
  sessionATimelineRowCount: number;
}

type FlowOutcome = { ok: true; flow: FlowResult } | { ok: false; error: string };

describe("ISS-0032 R9 browser flow: the overview + session view seam", () => {
  let outcome: FlowOutcome = { ok: false, error: "beforeAll did not run" };

  const tmpRepos: TmpRepo[] = [];
  const liveChildren: ChildProcess[] = [];
  const browserSessions: BrowserSession[] = [];

  async function runFlow(): Promise<FlowResult> {
    assertBuilt();

    const repo = await createTmpRepo();
    tmpRepos.push(repo);

    const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
    if (initResult.exitCode !== 0) {
      throw new Error(`test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`);
    }

    const paths = getPaths(repo.root);
    const hookCommand = ["node", paths.hookArtifact, repo.root];

    const headlessLines = loadFixtureStream("headless");
    const interactiveLines = loadFixtureStream("interactive");

    // A: headless, one passing bound check, cost deterministically ABSENT
    // with a recorded reason (transcript_path pinned to a nonexistent path).
    const nonexistentTranscriptA = join(repo.base, "no-such-transcript-a.jsonl");
    const linesA = overrideSessionId(headlessLines, SESSION_A).map((l) => pinLine(l, repo.root, nonexistentTranscriptA));
    await replayLines(truncatedOpenLines(linesA), hookCommand);
    const checkA = await runCli(["check", "i32-check-a", "--", "node", "-e", "process.exit(0)"], {
      cwd: repo.root,
      home: repo.home,
      registryPath: repo.registryPath,
    });
    if (checkA.exitCode !== 0) {
      throw new Error(`test setup invariant: the passing check for session A must exit 0; stderr: ${checkA.stderr}`);
    }
    await closeHookSession(hookCommand, linesA);

    // B: headless, one failing bound check.
    const linesB = overrideSessionId(headlessLines, SESSION_B);
    await replayLines(truncatedOpenLines(linesB), hookCommand);
    const checkB = await runCli(["check", "i32-check-b", "--", "node", "-e", "process.exit(1)"], {
      cwd: repo.root,
      home: repo.home,
      registryPath: repo.registryPath,
    });
    if (checkB.exitCode !== 1) {
      throw new Error(`test setup invariant: the failing check for session B must exit 1; stderr: ${checkB.stderr}`);
    }
    await closeHookSession(hookCommand, linesB);

    // C: headless, zero bound checks.
    await replayLines(overrideSessionId(headlessLines, SESSION_C), hookCommand);

    // D: interactive.
    await replayLines(overrideSessionId(interactiveLines, SESSION_D), hookCommand);

    // E: hand-authored kind-ABSENT (source "clear", no transcript at all).
    const nowIso = new Date().toISOString();
    appendHandAuthoredSession(paths.spool, nowIso, SESSION_E, repo.root, "clear", null);

    // F: hand-authored, out-of-range cc_version -> a drift entry. Source
    // "clear" (kind ABSENT) so this session never joins the headless
    // denominator the "1 of 3" headline depends on.
    const driftTranscriptPath = join(repo.base, "drift-out-of-range.transcript.jsonl");
    writeFileSync(driftTranscriptPath, `${JSON.stringify({ version: DRIFT_VERSION, type: "summary" })}\n`);
    appendHandAuthoredSession(paths.spool, nowIso, SESSION_F, repo.root, "clear", driftTranscriptPath);

    const opened = await spawnOpenAndWaitForUrl(repo.root, envFor({ home: repo.home, registryPath: repo.registryPath }));
    liveChildren.push(opened.child);

    const session = await launchHeadlessSession();
    if (!session) {
      throw new Error(
        "playwright is not installed yet (tests/acceptance/ISS-0032/browser-harness.ts's launchHeadlessSession " +
          "returned undefined) -- expected until playwright lands as a devDependency in package.json/pnpm-lock.yaml",
      );
    }
    browserSessions.push(session);

    await gotoUrl(session, opened.url);
    const overviewText = await pageText(session);

    const screenshotPath = join(repo.base, "evidence", "overview.png");
    await captureScreenshot(session, screenshotPath);

    const failingRowText: string = await session.page
      .locator("a", { hasText: shortId(SESSION_B) })
      .first()
      .innerText();
    const unknownRowText: string = await session.page
      .locator("a", { hasText: shortId(SESSION_E) })
      .first()
      .innerText();

    await session.page.locator("a", { hasText: shortId(SESSION_A) }).first().click();
    await session.page.waitForLoadState("networkidle");
    const sessionAText = await pageText(session);
    const sessionAAbsentSummaryCount: number = await session.page.locator("summary", { hasText: "ABSENT" }).count();
    const sessionATimelineRowCount: number = await session.page
      .locator("span", { hasText: /^(lifecycle|prompt|command|subagent)$/ })
      .count();

    return {
      overviewText,
      failingRowText,
      unknownRowText,
      screenshotPath,
      sessionAText,
      sessionAAbsentSummaryCount,
      sessionATimelineRowCount,
    };
  }

  beforeAll(async () => {
    try {
      outcome = { ok: true, flow: await runFlow() };
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) };
    }
  }, 180_000);

  afterAll(async () => {
    for (const session of browserSessions) {
      await closeBrowserSession(session).catch(() => undefined);
    }
    for (const child of liveChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await waitForExit(child);
    }
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  }, 60_000);

  function requireFlow(): FlowResult {
    if (!outcome.ok) {
      throw new Error(
        `R9 browser flow setup failed -- this is the expected red state before the flow is fully wired up: ${outcome.error}`,
      );
    }
    return outcome.flow;
  }

  it("Against a repo seeded with headless A (passing bound check), headless B (failing bound check), headless C (no checks), interactive D, hand-authored kind-ABSENT E, and a hand-authored drift session, a headless chromium session loads the printed URL and the overview shows the headline 1 of 3 with the failing session and the unknown-kind session surfaced and the drift banner visible.", () => {
    const flow = requireFlow();

    expect(flow.overviewText, `the overview must show the headline "1 of 3"; overview text was: ${flow.overviewText}`).toContain(
      "1 of 3",
    );
    expect(
      flow.overviewText,
      `the overview must surface the unknown-kind sessions via its banner; overview text was: ${flow.overviewText}`,
    ).toContain("of unknown kind");
    expect(flow.failingRowText, `session B's own row must surface it as failing; row text was: ${flow.failingRowText}`).toContain(
      "failing",
    );
    expect(
      flow.unknownRowText,
      `session E's own row must surface it as unknown kind; row text was: ${flow.unknownRowText}`,
    ).toContain("unknown");
    expect(
      flow.overviewText,
      `the drift banner must be visible; overview text was: ${flow.overviewText}`,
    ).toContain("Drift banner");
    expect(flow.overviewText, "the drift banner must name the session's actual out-of-range version").toContain(DRIFT_VERSION);
    expect(flow.overviewText, "the drift banner must name the tested range's minimum").toContain(TESTED_CLAUDE_CODE_RANGE.min);
    expect(flow.overviewText, "the drift banner must name the tested range's maximum").toContain(TESTED_CLAUDE_CODE_RANGE.max);
  });

  it("In the same chromium session, navigating to session A's view shows the derived-marked cost, at least one check badge, an ABSENT facet rendered with the explicit absent marker and its recorded reason, and timeline rows.", () => {
    const flow = requireFlow();

    expect(flow.sessionAText, `session A's view must show the Cost facet; page text was: ${flow.sessionAText}`).toContain("Cost");
    expect(flow.sessionAText, "session A's cost figure must carry the derived marker").toContain("derived");
    expect(
      flow.sessionAAbsentSummaryCount,
      "session A's view must render at least one explicit ABSENT disclosure marker",
    ).toBeGreaterThan(0);
    expect(
      flow.sessionAText,
      "session A's ABSENT cost facet must carry its recorded reason (src/core/absence.ts's own closed vocabulary)",
    ).toContain("transcript unavailable");
    expect(flow.sessionAText, "session A's view must show at least one check badge (the passing bound check)").toContain(
      "passed",
    );
    expect(flow.sessionATimelineRowCount, "session A's view must show timeline rows").toBeGreaterThan(0);
  });

  it("The browser flow captures a screenshot of the overview as its evidence artifact.", () => {
    const flow = requireFlow();

    expect(existsSync(flow.screenshotPath), `the overview screenshot must exist at ${flow.screenshotPath}`).toBe(true);
    const stats = statSync(flow.screenshotPath);
    expect(stats.size, "the screenshot file must be non-empty").toBeGreaterThan(0);
  });
});

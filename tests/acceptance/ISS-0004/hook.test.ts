// ISS-0004 acceptance tests — the hook artifact: capture and boundary
// enrichment (docs/issues/ISS-0004.md).
//
// Test-harness contract: this file reuses the acceptance harness's four
// primitives verbatim from ../harness/index.js (tmpdir-repo factory, CLI
// runner is not needed here, fixture replayer, and readSpool). It never
// calls `init` — the init slice (ISS-0005) depends on this issue, not the
// reverse — so "installing" the artifact here means copying the *built*
// artifact into a tmpdir repo's `.coreartifact/` directory and invoking it
// by absolute path, exactly the way `init` will.
//
// Expected module under test: a single zero-dependency file at
// src/hook/capture.ts, compiled by the harness's globalSetup `tsc` build to
// dist/hook/capture.js (mirrors src/cli/bin.ts -> dist/cli/bin.js). This is
// never statically imported in-process here (only the below-the-seam unit
// tests at tests/unit/hook/capture.test.ts do that) — every case in this
// file spawns the compiled artifact as a real subprocess.
//
// Init-root fallback contract (owned by this issue per the spec's
// "Test-harness contract" section — "an argv argument or an environment
// value baked into the installed hook config... Name it explicitly"): this
// suite fixes it as a single positional argv argument, `node <artifact>
// <initRoot>`. This is the only shape a hook config's single "command"
// string can bake in without also wiring a separate env block, and it is
// what every invocation below relies on end to end.
//
// Attribution note: the harness's fixture replayer spawns the hook command
// without setting a per-invocation OS cwd (it inherits vitest's own
// process cwd), so the artifact cannot rely on `process.cwd()` for
// attribution — it must resolve attribution from the hook payload's own
// `cwd` field (which every real hook payload carries, per schema.md
// Surface 2 / spec-v1.md). Recorded fixture `cwd` values are absolute
// paths from the machine/session they were recorded on and never exist on
// this test machine, so replaying them verbatim always falls back to the
// supplied init root — which is exactly the degradation path criterion 4
// exercises, and which every other assertion below relies on to land in a
// single, known spool file.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, copyFileSync, chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createTmpRepo, replayFixtures, replayFixturesParallel, readSpool, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream, type ScenarioName } from "../../fixtures/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const ARTIFACT_SOURCE = join(REPO_ROOT, "dist", "hook", "capture.js");

function assertArtifactBuilt(): string {
  if (!existsSync(ARTIFACT_SOURCE)) {
    throw new Error(
      `hook artifact build not found at ${ARTIFACT_SOURCE}. Expected ISS-0004 to ship a ` +
        "zero-dependency single file at src/hook/capture.ts (built to dist/hook/capture.js " +
        "by the harness's globalSetup tsc build) that reads a hook payload from stdin, " +
        "appends one v1 spool envelope line, performs boundary git enrichment on " +
        "SessionStart/SessionEnd, and always exits 0.",
    );
  }
  return ARTIFACT_SOURCE;
}

// Installs the built artifact into a tmpdir repo the way `init` will:
// copied into the repo's `.coreartifact/` directory, referenced afterward
// by absolute path. Mirrors the installed filename src/core/paths.ts's
// getPaths() already fixes (`hooks/capture.mjs`) so this test's install
// shape matches the one real convention already committed to the repo.
function installArtifact(repoRoot: string): string {
  const source = assertArtifactBuilt();
  const hooksDir = join(repoRoot, ".coreartifact", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const installedPath = join(hooksDir, "capture.mjs");
  copyFileSync(source, installedPath);
  return installedPath;
}

function hookCommand(installedArtifactPath: string, initRoot: string): string[] {
  return ["node", installedArtifactPath, initRoot];
}

function spoolPathFor(repoRoot: string): string {
  return join(repoRoot, ".coreartifact", "spool.jsonl");
}

interface RawInvocationResult {
  exitCode: number;
}

// A single raw invocation of the hook command with caller-supplied stdin
// bytes — needed for the failure-mode and boundary-enrichment cases below,
// none of which are a named fixture scenario the harness's replayer can
// load by name.
function runArtifactRaw(command: string[], stdinText: string): Promise<RawInvocationResult> {
  const [cmd, ...args] = command;
  if (!cmd) throw new Error("runArtifactRaw: empty command");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ exitCode: code ?? -1 });
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

describe("ISS-0004 hook artifact: capture and boundary enrichment", () => {
  const tmpRepos: TmpRepo[] = [];
  const scratchDirs: string[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "R4 Capture. Replaying each recorded fixture stream through the installed hook command verbatim: one spool line per event; every line parses as envelope v1 with the payload byte-preserved; boundary lines carry head sha + dirty flag; N parallel interleaved replays lose zero lines (spool line count = sum of inputs).",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const installedPath = installArtifact(repo.root);
      const command = hookCommand(installedPath, repo.root);
      const spoolPath = spoolPathFor(repo.root);

      const scenarios: ScenarioName[] = ["interactive", "headless", "worktree", "SIGTERM", "SIGKILL"];
      let expectedSequentialLines = 0;
      for (const scenario of scenarios) {
        const lines = loadFixtureStream(scenario);
        expectedSequentialLines += lines.length;
        const result = await replayFixtures(scenario, command);
        expect(result.invocations.length, `${scenario} stream produced no invocations`).toBe(lines.length);
        for (const invocation of result.invocations) {
          expect(invocation.exitCode, `a "${scenario}" invocation did not exit 0`).toBe(0);
        }
      }

      const parsedLines = readSpool(spoolPath);
      expect(
        parsedLines.length,
        "spool line count does not equal one line per replayed event across every scenario",
      ).toBe(expectedSequentialLines);

      for (const parsed of parsedLines) {
        expect(parsed.ok, `a spool line failed to parse as envelope v1: ${JSON.stringify(parsed)}`).toBe(true);
      }

      // Byte preservation: replay order is deterministic (sequential, one
      // invocation per line, scenarios processed in the order iterated
      // above), so the Nth spool line's event text must equal the Nth
      // fixture line's own source text exactly.
      const allFixtureLines = scenarios.flatMap((scenario) => loadFixtureStream(scenario));
      for (let i = 0; i < allFixtureLines.length; i += 1) {
        const parsed = parsedLines[i];
        const expectedLine = allFixtureLines[i];
        if (!parsed || !parsed.ok || expectedLine === undefined) continue; // already asserted ok above
        expect(parsed.eventText, `spool line ${i} did not byte-preserve its source fixture line`).toBe(
          expectedLine.trim(),
        );
      }

      // Boundary enrichment, positive case: recorded fixtures' own `cwd`
      // values never resolve on this machine (see file header), so proving
      // "boundary lines carry head sha + dirty flag" needs one payload
      // whose cwd genuinely resolves. Reuse a real recorded SessionStart
      // line's fields verbatim, substituting only the `cwd` value for this
      // repo's own root (a real, resolvable git repo) rather than
      // inventing a new payload shape.
      const recordedSessionStartLine = loadFixtureStream("headless")[0];
      if (!recordedSessionStartLine) throw new Error("headless fixture has no lines to reuse");
      const recordedSessionStart = JSON.parse(recordedSessionStartLine);
      expect(recordedSessionStart.hook_event_name, "test setup invariant: expected a SessionStart payload").toBe(
        "SessionStart",
      );
      const boundaryPayload = { ...recordedSessionStart, cwd: repo.root };
      const boundaryText = JSON.stringify(boundaryPayload);

      const beforeCount = readSpool(spoolPath).length;
      const boundaryResult = await runArtifactRaw(command, boundaryText);
      expect(boundaryResult.exitCode, "boundary invocation with a resolvable cwd did not exit 0").toBe(0);

      const afterLines = readSpool(spoolPath);
      expect(afterLines.length, "the resolvable-cwd boundary event was not appended exactly once").toBe(
        beforeCount + 1,
      );
      const boundaryEnvelope = afterLines[afterLines.length - 1];
      if (!boundaryEnvelope || !boundaryEnvelope.ok) {
        throw new Error("the boundary spool line failed to parse as envelope v1");
      }
      expect(boundaryEnvelope.eventText, "the boundary spool line did not byte-preserve its payload").toBe(
        boundaryText,
      );
      expect(
        typeof boundaryEnvelope.git?.head,
        "a boundary line's git.head must be populated for a resolvable cwd",
      ).toBe("string");
      expect(
        typeof boundaryEnvelope.git?.dirty,
        "a boundary line's git.dirty must be populated for a resolvable cwd",
      ).toBe("boolean");

      // N parallel interleaved replays lose zero lines: spool line count
      // must equal the sum of every stream's inputs, none lost, none
      // duplicated. Exercised into a fresh install/spool so the count is
      // unambiguous.
      const parallelRepo = await createTmpRepo();
      tmpRepos.push(parallelRepo);
      const parallelInstalledPath = installArtifact(parallelRepo.root);
      const parallelCommand = hookCommand(parallelInstalledPath, parallelRepo.root);
      const parallelScenarios: ScenarioName[] = ["interactive", "headless", "worktree"];
      const expectedParallelLines = parallelScenarios.reduce(
        (sum, scenario) => sum + loadFixtureStream(scenario).length,
        0,
      );

      const parallelResults = await replayFixturesParallel(
        parallelScenarios.map((scenario) => ({ scenario, command: parallelCommand })),
      );
      const totalParallelInvocations = parallelResults.reduce((sum, r) => sum + r.invocations.length, 0);
      expect(totalParallelInvocations, "parallel replay invocation count does not equal the sum of the inputs").toBe(
        expectedParallelLines,
      );
      for (const result of parallelResults) {
        for (const invocation of result.invocations) {
          expect(invocation.exitCode, "a parallel invocation did not exit 0").toBe(0);
        }
      }

      const parallelSpoolPath = spoolPathFor(parallelRepo.root);
      const parallelLines = readSpool(parallelSpoolPath);
      expect(
        parallelLines.length,
        "N parallel interleaved replays did not produce a spool line count equal to the sum of inputs",
      ).toBe(expectedParallelLines);
      for (const parsed of parallelLines) {
        expect(parsed.ok, "a parallel-replayed spool line failed to parse as envelope v1").toBe(true);
      }
    },
    60000,
  );

  it(
    "The hook artifact exits 0 for every input, including a payload that is not valid JSON, an empty stdin, and a spool directory that does not exist; a capture failure never breaks the host session and never writes a partial line to the spool.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const installedPath = installArtifact(repo.root);
      const command = hookCommand(installedPath, repo.root);
      const spoolPath = spoolPathFor(repo.root);

      const invalidJsonResult = await runArtifactRaw(command, "not valid json {{{");
      expect(invalidJsonResult.exitCode, "a payload that is not valid JSON did not exit 0").toBe(0);

      const emptyStdinResult = await runArtifactRaw(command, "");
      expect(emptyStdinResult.exitCode, "empty stdin did not exit 0").toBe(0);

      // A spool directory that does not exist and cannot be created: an
      // init root the process has no write permission inside, so
      // `.coreartifact/` can never be created under it.
      const unwritableRoot = mkdtempSync(join(tmpdir(), "coreartifact-unwritable-"));
      try {
        chmodSync(unwritableRoot, 0o500);
        const unwritableCommand = hookCommand(installedPath, unwritableRoot);
        const unwritablePayload = JSON.stringify({
          session_id: "iss0004-unwritable-dir-test",
          hook_event_name: "PreToolUse",
          cwd: "/nonexistent-cwd-for-coreartifact-test",
          transcript_path: "/nonexistent-transcript-for-coreartifact-test.jsonl",
        });
        const unwritableResult = await runArtifactRaw(unwritableCommand, unwritablePayload);
        expect(unwritableResult.exitCode, "a spool directory that does not exist and cannot be created did not exit 0").toBe(
          0,
        );
      } finally {
        chmodSync(unwritableRoot, 0o700);
        rmSync(unwritableRoot, { recursive: true, force: true });
      }

      // No partial line: whatever the spool ended up containing after
      // every failure-mode invocation above, every line present parses
      // cleanly — never a truncated/corrupt trailing record.
      const parsedLines = readSpool(spoolPath);
      for (const parsed of parsedLines) {
        expect(parsed.ok, `a capture failure left a partially written spool line: ${JSON.stringify(parsed)}`).toBe(
          true,
        );
      }
    },
    30000,
  );

  it(
    "The hook artifact runs from a checkout with no node_modules present: invoking the built artifact by absolute path from a tmpdir git repo that has no node_modules directory appends the envelope line and exits 0.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      expect(
        existsSync(join(repo.root, "node_modules")),
        "test setup invariant: a fresh tmpdir repo must not have node_modules",
      ).toBe(false);

      const installedPath = installArtifact(repo.root);
      const command = hookCommand(installedPath, repo.root);

      const recordedLine = loadFixtureStream("headless")[0];
      if (!recordedLine) throw new Error("headless fixture has no lines to reuse");
      const payloadWithResolvableCwd = { ...JSON.parse(recordedLine), cwd: repo.root };
      const payloadText = JSON.stringify(payloadWithResolvableCwd);

      const result = await runArtifactRaw(command, payloadText);
      expect(result.exitCode, "invoking the built artifact from a no-node_modules checkout did not exit 0").toBe(0);

      const spoolPath = spoolPathFor(repo.root);
      expect(
        existsSync(join(repo.root, "node_modules")),
        "invoking the artifact must not create a node_modules directory",
      ).toBe(false);

      const parsedLines = readSpool(spoolPath);
      expect(parsedLines.length, "invoking the artifact did not append exactly one envelope line").toBe(1);
      const [envelope] = parsedLines;
      if (!envelope || !envelope.ok) {
        throw new Error("the appended spool line failed to parse as envelope v1");
      }
      expect(envelope.eventText, "the appended line did not byte-preserve the payload").toBe(payloadText);
    },
    30000,
  );

  it(
    "A boundary payload delivered with a cwd whose git resolution fails records the git head and dirty keys as absent in the envelope rather than as an empty string, zero or false.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const installedPath = installArtifact(repo.root);
      // The init-root fallback is a real, writable repo so the write
      // itself succeeds — only the payload's own `cwd` fails to resolve as
      // a git repo, which is what this criterion is about.
      const command = hookCommand(installedPath, repo.root);

      // Reuse a real recorded SessionStart line verbatim: recorded
      // fixtures' `cwd` values are absolute paths from the recording
      // machine/session and never exist on this test machine, so git
      // resolution against it genuinely fails here — no payload shape is
      // invented.
      const boundaryLine = loadFixtureStream("headless")[0];
      if (!boundaryLine) throw new Error("headless fixture has no SessionStart line to reuse");
      const boundaryPayload = JSON.parse(boundaryLine);
      expect(boundaryPayload.hook_event_name, "test setup invariant: expected a SessionStart boundary payload").toBe(
        "SessionStart",
      );
      expect(
        existsSync(boundaryPayload.cwd),
        "test setup invariant: the recorded cwd must not exist on this machine",
      ).toBe(false);

      const result = await runArtifactRaw(command, boundaryLine);
      expect(result.exitCode, "a boundary invocation with an unresolvable cwd did not exit 0").toBe(0);

      const spoolPath = spoolPathFor(repo.root);
      const parsedLines = readSpool(spoolPath);
      expect(parsedLines.length, "the boundary event was not appended exactly once").toBe(1);
      const [envelope] = parsedLines;
      if (!envelope || !envelope.ok) {
        throw new Error("the appended spool line failed to parse as envelope v1");
      }

      expect(
        envelope.git?.head,
        "git.head must be absent, never a fabricated empty string, for an unresolvable cwd",
      ).toBeUndefined();
      expect(
        envelope.git?.dirty,
        "git.dirty must be absent, never a fabricated false, for an unresolvable cwd",
      ).toBeUndefined();
    },
    30000,
  );

  // S2 / S0 regression pin (2026-07-14 amendment). `init` copies the
  // artifact into `.coreartifact/`, which is reached through symlinks
  // constantly (npx cache, node_modules/.bin, /tmp on macOS) — this is the
  // exact install shape the previous attempt's `isMainModule()`
  // path-comparison guard silently broke under (the ESM loader realpaths
  // the main module but Node does not realpath `process.argv[1]`, so the
  // two diverge through any symlink and the guard reads false, `main()`
  // never runs, and the hook captures nothing while exiting 0). This test
  // invokes the installed artifact THROUGH a symlink the same way those
  // real install paths do, and MUST fail red if a path-comparison
  // entrypoint guard is reintroduced.
  it(
    "invoking the installed artifact through a symlink (as node_modules/.bin, the npx cache, and /tmp on macOS all do) still appends the spool line and exits 0 (S0 regression pin)",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const installedPath = installArtifact(repo.root);

      const linkDir = mkdtempSync(join(tmpdir(), "coreartifact-symlink-bin-"));
      scratchDirs.push(linkDir);
      const symlinkPath = join(linkDir, "capture-link.mjs");
      symlinkSync(installedPath, symlinkPath);

      const command = hookCommand(symlinkPath, repo.root);
      const recordedLine = loadFixtureStream("headless")[0];
      if (!recordedLine) throw new Error("headless fixture has no lines to reuse");
      const payloadWithResolvableCwd = { ...JSON.parse(recordedLine), cwd: repo.root };
      const payloadText = JSON.stringify(payloadWithResolvableCwd);

      const result = await runArtifactRaw(command, payloadText);
      expect(result.exitCode, "invoking the artifact through a symlink did not exit 0").toBe(0);

      const spoolPath = spoolPathFor(repo.root);
      const parsedLines = readSpool(spoolPath);
      expect(
        parsedLines.length,
        "invoking the artifact through a symlink did not append the spool line — an entrypoint guard that " +
          "compares fileURLToPath(import.meta.url) to process.argv[1] silently no-ops through a symlink " +
          "because the ESM loader realpaths the main module while argv[1] stays unrealpathed",
      ).toBe(1);
      const [envelope] = parsedLines;
      if (!envelope || !envelope.ok) {
        throw new Error("the spool line written via a symlinked invocation failed to parse as envelope v1");
      }
      expect(envelope.eventText, "the symlinked invocation did not byte-preserve the payload").toBe(payloadText);
    },
    30000,
  );

  // S2 / S1 regression pin (2026-07-14 amendment). Claude Code pipes a hook
  // payload on stdin with an ordinary trailing newline — this is the
  // literal byte shape of a real invocation, not a test artifact. The
  // fixture replayer's stream-splitting (`loadFixtureStream`) already
  // strips line endings before handing a line to `runOneInvocation`, so the
  // R4 replay above never actually exercises a trailing `\n` on the wire;
  // this case delivers one explicitly. MUST fail red if the control-char
  // rejection check runs against raw, untrimmed stdin (the S1 bug: a
  // trailing `\n` matches the same `/[\x00-\x1f]/` check meant for interior
  // corruption, and the payload is silently dropped with no error).
  it(
    "a payload delivered with a trailing newline directly on stdin (the ordinary shape of a piped hook payload) is written, not silently dropped (S1 regression pin)",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const installedPath = installArtifact(repo.root);
      const command = hookCommand(installedPath, repo.root);

      const recordedLine = loadFixtureStream("headless")[0];
      if (!recordedLine) throw new Error("headless fixture has no lines to reuse");
      const payloadWithResolvableCwd = { ...JSON.parse(recordedLine), cwd: repo.root };
      const payloadText = JSON.stringify(payloadWithResolvableCwd);
      const stdinWithTrailingNewline = `${payloadText}\n`;

      const result = await runArtifactRaw(command, stdinWithTrailingNewline);
      expect(result.exitCode, "a newline-terminated stdin payload did not exit 0").toBe(0);

      const spoolPath = spoolPathFor(repo.root);
      const parsedLines = readSpool(spoolPath);
      expect(
        parsedLines.length,
        "a payload delivered with an ordinary trailing newline was silently dropped instead of written",
      ).toBe(1);
      const [envelope] = parsedLines;
      if (!envelope || !envelope.ok) {
        throw new Error("the spool line written from a newline-terminated payload failed to parse as envelope v1");
      }
      // Byte preservation: the spool line's event text is the payload with
      // the trailing newline stripped (framing), never the payload text
      // re-embedded with the newline still inside it (which would desync
      // line_no) and never anything other than the original payload bytes.
      expect(
        envelope.eventText,
        "the written line did not byte-preserve the payload once its trailing newline framing was stripped",
      ).toBe(payloadText);
    },
    30000,
  );
});

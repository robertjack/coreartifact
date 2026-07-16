// ISS-0023 acceptance tests — consent + the weekly ping (docs/issues/
// ISS-0023.md). Read docs/gotchas.md first (entry 3: allowlist env, entry
// 5: silence folds to no) — both apply directly to this suite.
//
// Test-harness contract: createTmpRepo/readSpool/etc. come from
// ../harness/index.js verbatim, never forked. The CLI subprocess runner and
// hook-artifact runner used here are LOCAL to this issue (./helpers.ts),
// not an edit to ../harness/cliRunner.ts — that file sits outside this
// issue's writable footprint, and the packet's own "Specifics" section asks
// for an env-parameter extension that this local runner supplies instead.
//
// src/ping/** and src/install/consent.ts (the modules under test) do not
// exist yet. Nothing in this file imports them at module scope; every
// touch goes through the CLI subprocess boundary (spawnCli/
// spawnHookArtifact) or a caught dynamic import (resolveNamedExport) so a
// missing module reads as a red assertion, never a collection-time crash
// that would leave every criterion unmapped.
//
// src/core/operatorState.ts (ISS-0015) and src/core/paths.ts (ISS-0001)
// already exist and are stable, already-merged contracts this issue reads
// and writes through rather than reimplementing — they are imported
// statically.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTmpRepo, type TmpRepo } from "../harness/index.js";
import { appendInstall, appendConsent, readState } from "../../../src/core/operatorState.js";
import {
  spawnCli,
  spawnHookArtifact,
  withTimeout,
  createSiblingRepo,
  readSinkEntries,
  countStateLines,
  PACKAGE_VERSION,
  UUID_SHAPE,
  PING_MODULE_CANDIDATES,
  resolveNamedExport,
} from "./helpers.js";

describe("ISS-0023 consent + the weekly ping", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const pending = cleanups.splice(0);
    await Promise.all(pending.map((fn) => fn()));
  });

  function track(repo: TmpRepo): TmpRepo {
    cleanups.push(repo.cleanup);
    return repo;
  }

  it(
    `R10 Consent, asked once. First init on the machine asks the one opt-in question (anonymous weekly ping, version + install id), default no; the answer and a generated install id persist globally; subsequent inits in other repos do not re-ask. Non-interactive init (no TTY) records "no" without hanging — the fleet lane never blocks on a prompt.`,
    async () => {
      const repoA = track(await createTmpRepo());
      const statePath = join(repoA.registryRoot, "state.jsonl");

      // Non-interactive: the spawned child's stdin is a plain pipe, never a
      // TTY, and the parent never writes to or closes it — a correct
      // implementation must never block waiting on it.
      const first = await withTimeout(
        spawnCli(["init"], { cwd: repoA.root, home: repoA.home, registryRoot: repoA.registryRoot }),
        10_000,
        "coreartifact init hung on a non-interactive (piped-stdin) invocation instead of recording 'no' immediately",
      );
      expect(first.exitCode).toBe(0);

      const folded = await readState(statePath);
      expect(folded.install_id).toBeTruthy();
      expect(UUID_SHAPE.test(String(folded.install_id))).toBe(true);
      // Default no: an empty/no answer (guaranteed by non-TTY, no prompt
      // ever asked) must record consent off, never a flattering yes.
      expect(folded.consent).toBe(false);

      // Both ops (install, consent) are appended exactly once, ever.
      expect(countStateLines(statePath)).toBe(2);

      // A second init from a DIFFERENT repo on the SAME machine (same HOME
      // / registry root) must not re-ask and must not append a second
      // install/consent pair.
      const repoBRoot = createSiblingRepo(repoA.base, repoA.home);
      const second = await withTimeout(
        spawnCli(["init"], { cwd: repoBRoot, home: repoA.home, registryRoot: repoA.registryRoot }),
        10_000,
        "second init on the same machine hung instead of skipping the (already-answered) consent question",
      );
      expect(second.exitCode).toBe(0);

      const foldedAfter = await readState(statePath);
      // The install id, once generated, never changes.
      expect(foldedAfter.install_id).toBe(folded.install_id);
      expect(foldedAfter.consent).toBe(false);
      // Still exactly 2 lines: no new install/consent ops were appended by
      // the second init.
      expect(countStateLines(statePath)).toBe(2);
    },
  );

  it(
    `R11 Ping, opt-in and inert. With consent off: zero network attempts across all CLI commands (asserted through the injected transport — silence is the test). With consent on and the last ping older than the named weekly interval: exactly one POST to the pinned endpoint constant whose payload contains exactly two fields, version and install id — nothing else ever (law). A second invocation inside the interval sends nothing. A failing/unreachable endpoint changes no command's output or exit code (fire-and-forget). The ping rides only the CLI entry — never the hook artifact.`,
    async () => {
      const repo = track(await createTmpRepo());
      const sinkPath = join(repo.base, "sink.jsonl");
      const statePath = join(repo.registryRoot, "state.jsonl");

      // 1. Consent off (never answered/opted in) -> zero attempts.
      await spawnCli(["log"], { cwd: repo.root, home: repo.home, registryRoot: repo.registryRoot, sinkPath });
      expect(readSinkEntries(sinkPath)).toHaveLength(0);

      // 2. Flip consent on through the operator-state contract module (the
      // documented hand-edit path, packet "Subsequent inits ..."), with no
      // prior ping -> the weekly gate is open.
      const installId = "11111111-2222-4333-8444-555555555555";
      await appendInstall(installId, statePath);
      await appendConsent(true, statePath);

      const pinged = await spawnCli(["log"], {
        cwd: repo.root,
        home: repo.home,
        registryRoot: repo.registryRoot,
        sinkPath,
      });
      expect(pinged.exitCode).toBe(0);

      const afterOne = readSinkEntries(sinkPath);
      expect(afterOne).toHaveLength(1);
      expect(typeof afterOne[0]!.url).toBe("string");
      expect(String(afterOne[0]!.url)).toMatch(/^https:\/\/coreartifact\.com\//);
      const payload = afterOne[0]!.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["install_id", "version"]);
      expect(payload.install_id).toBe(installId);
      expect(payload.version).toBe(PACKAGE_VERSION);

      // 3. A second invocation inside the interval sends nothing.
      await spawnCli(["log"], { cwd: repo.root, home: repo.home, registryRoot: repo.registryRoot, sinkPath });
      expect(readSinkEntries(sinkPath)).toHaveLength(1);

      // 4. The ping rides only the CLI entry, never the hook artifact:
      // invoking the built hook artifact directly (exactly how `init`
      // installs it and a real hook config invokes it) with the SAME
      // consent-on state and sink must not grow the sink at all.
      await spawnHookArtifact(
        repo.root,
        { home: repo.home, registryRoot: repo.registryRoot, sinkPath },
        `${JSON.stringify({ hook_event_name: "SessionStart", session_id: "iss-0023-hook-probe", cwd: repo.root, transcript_path: "/nonexistent" })}\n`,
      );
      expect(readSinkEntries(sinkPath)).toHaveLength(1);
    },
  );

  it(
    `The ping transport is injectable and the acceptance seam observes it through a recording sink named by the COREARTIFACT_PING_SINK environment variable: with consent off, running init, log, show, check and doctor leaves the sink empty — zero attempts is the asserted silence; no test performs real network I/O.`,
    async () => {
      const repo = track(await createTmpRepo());
      const sinkPath = join(repo.base, "sink.jsonl");
      const statePath = join(repo.registryRoot, "state.jsonl");

      const invocations: string[][] = [["init"], ["log"], ["show"], ["check"], ["doctor"]];
      for (const args of invocations) {
        await spawnCli(args, { cwd: repo.root, home: repo.home, registryRoot: repo.registryRoot, sinkPath });
      }

      // The asserted silence: no line was ever appended to the injected
      // sink across any of the five invocations above.
      expect(readSinkEntries(sinkPath)).toHaveLength(0);

      // This criterion's own setup describes "running init ... (non-TTY ->
      // records no)" as its precondition — without that having actually
      // happened, the silence assertion above is trivially true for the
      // wrong reason (nothing implemented, nothing ever pings anyone).
      // Confirming the precondition itself makes the test fail for the
      // right reason until consent recording exists.
      const folded = await readState(statePath);
      expect(folded.install_id).toBeTruthy();
      expect(folded.consent).toBe(false);
    },
  );

  it(
    `With consent on and no prior ping, one CLI invocation records exactly one attempt whose payload is a JSON object with exactly the two keys version and install_id; a second invocation inside the weekly interval records nothing; the interval is a named seven-day constant and the endpoint is a single pinned constant naming the coreartifact.com host.`,
    async () => {
      const repo = track(await createTmpRepo());
      const sinkPath = join(repo.base, "sink.jsonl");
      const statePath = join(repo.registryRoot, "state.jsonl");
      const installId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      await appendInstall(installId, statePath);
      await appendConsent(true, statePath);

      await spawnCli(["log"], { cwd: repo.root, home: repo.home, registryRoot: repo.registryRoot, sinkPath });
      const first = readSinkEntries(sinkPath);
      expect(first).toHaveLength(1);
      const payload = first[0]!.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["install_id", "version"]);
      expect(payload.install_id).toBe(installId);
      expect(payload.version).toBe(PACKAGE_VERSION);

      await spawnCli(["log"], { cwd: repo.root, home: repo.home, registryRoot: repo.registryRoot, sinkPath });
      expect(readSinkEntries(sinkPath)).toHaveLength(1);

      // The interval is a NAMED seven-day constant — resolved from the
      // actual module under test (several candidate file layouts under the
      // owned src/ping/** glob), never a hardcoded guess of its value.
      const interval = await resolveNamedExport(PING_MODULE_CANDIDATES, [
        "PING_INTERVAL_MS",
        "PING_INTERVAL",
        "INTERVAL_MS",
      ]);
      if (interval === undefined) {
        throw new Error(
          "not implemented yet: no PING_INTERVAL_MS-shaped export found under any of " +
            PING_MODULE_CANDIDATES.join(", "),
        );
      }
      expect(interval).toBe(7 * 24 * 60 * 60 * 1000);

      // The endpoint is a single pinned constant naming the
      // coreartifact.com host — same resolution strategy.
      const endpoint = await resolveNamedExport(PING_MODULE_CANDIDATES, ["PING_ENDPOINT", "ENDPOINT", "PING_URL"]);
      if (endpoint === undefined) {
        throw new Error(
          "not implemented yet: no PING_ENDPOINT-shaped export found under any of " + PING_MODULE_CANDIDATES.join(", "),
        );
      }
      expect(typeof endpoint).toBe("string");
      expect(new URL(String(endpoint)).hostname).toBe("coreartifact.com");
    },
  );

  it(
    `The ping op is appended to the operator state at attempt time, not on success: a transport that fails still closes the weekly gate, and the failing transport changes no command's stdout, stderr or exit code.`,
    async () => {
      const repoGood = track(await createTmpRepo());
      const repoBad = track(await createTmpRepo());

      const goodSink = join(repoGood.base, "sink.jsonl");
      // A directory, not a file: appending a line to it always throws
      // EISDIR regardless of whether the implementation pre-creates parent
      // directories — a deterministic, real (non-network) transport
      // failure the injected sink seam can produce.
      const badSink = join(repoBad.base, "sink-is-a-directory");
      mkdirSync(badSink, { recursive: true });

      const goodState = join(repoGood.registryRoot, "state.jsonl");
      const badState = join(repoBad.registryRoot, "state.jsonl");
      await appendInstall("cccccccc-dddd-4eee-8fff-000000000001", goodState);
      await appendConsent(true, goodState);
      await appendInstall("cccccccc-dddd-4eee-8fff-000000000002", badState);
      await appendConsent(true, badState);

      const good = await spawnCli(["log"], {
        cwd: repoGood.root,
        home: repoGood.home,
        registryRoot: repoGood.registryRoot,
        sinkPath: goodSink,
      });
      const bad = await spawnCli(["log"], {
        cwd: repoBad.root,
        home: repoBad.home,
        registryRoot: repoBad.registryRoot,
        sinkPath: badSink,
      });

      // Fire-and-forget: an unwritable transport must change no command's
      // stdout, stderr or exit code relative to the same command with a
      // working transport under otherwise-identical conditions.
      expect(bad.exitCode).toBe(good.exitCode);
      expect(bad.stdout).toBe(good.stdout);
      expect(bad.stderr).toBe(good.stderr);

      // Attempt-time recording: the weekly gate closes whether or not
      // delivery succeeds — last_ping_at must be set even though the
      // transport failed to write.
      const foldedBad = await readState(badState);
      expect(foldedBad.last_ping_at).toBeTruthy();
    },
  );
});

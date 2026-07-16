// Unit coverage for src/ping/sender.ts (docs/issues/ISS-0023.md
// "Test-harness contract": "Interval boundary and attempt-time gating are
// unit territory: the sender takes an injectable now and transport ...
// cover never-pinged, inside-interval, outside-interval, and throwing
// transport (op still appended, error swallowed)"). This file never spawns
// a subprocess; it imports the source module directly and injects both
// `now` and `transport`.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendInstall, appendConsent, appendPing, readState } from "../../../src/core/operatorState.js";
import { maybeSendPing } from "../../../src/ping/sender.js";
import { PING_INTERVAL_MS, PING_ENDPOINT } from "../../../src/ping/constants.js";
import type { PingPayload } from "../../../src/ping/transport.js";

describe("ping sender (maybeSendPing)", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss0023-sender-unit-"));
    statePath = path.join(tmpDir, "state.jsonl");
  });

  function recordingTransport(): { calls: Array<{ url: string; payload: PingPayload }>; transport: (url: string, payload: PingPayload) => Promise<void> } {
    const calls: Array<{ url: string; payload: PingPayload }> = [];
    return {
      calls,
      transport: async (url, payload) => {
        calls.push({ url, payload });
      },
    };
  }

  it("consent off: never attempts, even with a never-pinged install id", async () => {
    await appendInstall("no-consent-id", statePath);
    // consent never recorded -> folds to false (degradation law)
    const { calls, transport } = recordingTransport();

    await maybeSendPing({ statePath, version: "1.2.3", transport });

    expect(calls).toHaveLength(0);
    const state = await readState(statePath);
    expect(state.last_ping_at).toBeNull();
  });

  it("consent on, never pinged: exactly one attempt, payload is exactly {version, install_id}, op appended", async () => {
    await appendInstall("install-a", statePath);
    await appendConsent(true, statePath);
    const { calls, transport } = recordingTransport();

    await maybeSendPing({ statePath, version: "1.2.3", transport });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PING_ENDPOINT);
    expect(Object.keys(calls[0].payload).sort()).toEqual(["install_id", "version"]);
    expect(calls[0].payload).toEqual({ version: "1.2.3", install_id: "install-a" });

    const state = await readState(statePath);
    expect(state.last_ping_at).toBeTruthy();
  });

  it("consent on, inside the interval: no attempt", async () => {
    await appendInstall("install-b", statePath);
    await appendConsent(true, statePath);
    // appendPing stamps `at` with the real wall clock (never the injected
    // `now`, which only gates the due-decision) — so the second call's
    // `now` must be computed relative to the ACTUAL recorded last_ping_at,
    // not an arbitrary injected epoch from the first call.
    await maybeSendPing({ statePath, version: "1.0.0", transport: recordingTransport().transport });
    const primed = await readState(statePath);
    const lastPingAt = Date.parse(primed.last_ping_at as string);

    const { calls, transport } = recordingTransport();
    await maybeSendPing({
      statePath,
      version: "1.0.0",
      transport,
      now: () => lastPingAt + PING_INTERVAL_MS - 1,
    });

    expect(calls).toHaveLength(0);
  });

  it("consent on, outside the interval: attempts again", async () => {
    await appendInstall("install-c", statePath);
    await appendConsent(true, statePath);
    await maybeSendPing({ statePath, version: "1.0.0", transport: recordingTransport().transport });
    const primed = await readState(statePath);
    const lastPingAt = Date.parse(primed.last_ping_at as string);

    const { calls, transport } = recordingTransport();
    await maybeSendPing({
      statePath,
      version: "1.0.0",
      transport,
      now: () => lastPingAt + PING_INTERVAL_MS + 1,
    });

    expect(calls).toHaveLength(1);
  });

  it("a throwing transport still appends the ping op (attempt-time recording) and the error is swallowed", async () => {
    await appendInstall("install-d", statePath);
    await appendConsent(true, statePath);
    const throwingTransport = async (): Promise<void> => {
      throw new Error("simulated transport failure");
    };

    await expect(
      maybeSendPing({ statePath, version: "1.0.0", transport: throwingTransport }),
    ).resolves.toBeUndefined();

    const state = await readState(statePath);
    expect(state.last_ping_at).toBeTruthy();
  });

  it("a never-pinged state (last_ping_at null) counts as older than the interval", async () => {
    await appendInstall("install-e", statePath);
    await appendConsent(true, statePath);
    const before = await readState(statePath);
    expect(before.last_ping_at).toBeNull();

    const { calls, transport } = recordingTransport();
    await maybeSendPing({ statePath, version: "1.0.0", transport, now: () => 0 });

    expect(calls).toHaveLength(1);
  });
});

// The CLI-layer entry for the weekly ping (docs/issues/ISS-0023.md "The
// ping (R11)" + "The injectable transport"). This is the ONE call site
// src/cli/index.ts's dispatcher makes, once per invocation, for any
// command — never the hook artifact (src/hook/capture.ts imports nothing
// from this package by design).
//
// Consent is checked here, BEFORE constructing any transport (packet
// "Invariants": "With COREARTIFACT_PING_SINK unset and consent off, the
// transport is never even constructed — silence by construction, not by
// filtering"). maybeSendPing (sender.ts) re-folds state internally to
// decide the weekly gate, which is a second, cheap read of the same small
// file — accepted so sender.ts stays independently testable with an
// injected transport per the packet's own test-authoring instructions,
// rather than this module reaching into its internals.
import { readState } from "../core/operatorState.js";
import { maybeSendPing } from "./sender.js";
import { createFetchTransport, createSinkTransport } from "./transport.js";
import { resolvePackageVersion } from "./version.js";
import { PING_EXIT_GRACE_MS } from "./constants.js";

export { PING_INTERVAL_MS, PING_ENDPOINT, PING_EXIT_GRACE_MS } from "./constants.js";
export { maybeSendPing } from "./sender.js";
export type { PingTransport, PingPayload } from "./transport.js";
export { createFetchTransport, createSinkTransport } from "./transport.js";

// @ts-ignore -- node:timers has no ambient types available in this sandbox
import { setTimeout as setTimeoutFn, clearTimeout as clearTimeoutFn } from "node:timers";

const setTimeoutRaw = setTimeoutFn as (fn: () => void, ms: number) => unknown;
const clearTimeoutRaw = clearTimeoutFn as (handle: unknown) => void;

const PING_SINK_ENV_VAR = "COREARTIFACT_PING_SINK";

export interface SendCliPingOptions {
  env: Record<string, string | undefined>;
  statePath?: string;
  now?: () => number;
}

export async function sendCliPing(options: SendCliPingOptions): Promise<void> {
  const state = await readState(options.statePath);
  if (!state.consent) return; // provably silent: no transport is ever built

  const sinkPath = options.env[PING_SINK_ENV_VAR];
  const transport = sinkPath && sinkPath.length > 0 ? createSinkTransport(sinkPath) : createFetchTransport();

  await maybeSendPing({
    statePath: options.statePath,
    now: options.now,
    version: resolvePackageVersion(),
    transport,
  });
}

// Races an in-flight ping (already started, never awaited on the command's
// own critical path — see src/cli/index.ts) against a short grace window
// before the CLI process exits (fix for ISS-0023 S2: "bound the attempt;
// never hold the event loop open past command completion"). A healthy
// endpoint that already resolved (or resolves within the grace) is awaited
// normally; a stalled one is abandoned once the grace elapses — the
// transport's own 2000ms timeout (transport.ts) still bounds the socket's
// life even though nothing in this process waits on it any longer.
//
// `pingPromise` must already have a `.catch` attached by the caller (never
// awaited raw here) so an unhandled rejection can never surface after this
// function has already resolved via the grace timer.
export function awaitPingWithGrace(pingPromise: Promise<unknown>, graceMs: number = PING_EXIT_GRACE_MS): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeoutRaw(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, graceMs);

    pingPromise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeoutRaw(timer);
        resolve();
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeoutRaw(timer);
        resolve();
      },
    );
  });
}

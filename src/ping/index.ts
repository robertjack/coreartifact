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

export { PING_INTERVAL_MS, PING_ENDPOINT } from "./constants.js";
export { maybeSendPing } from "./sender.js";
export type { PingTransport, PingPayload } from "./transport.js";
export { createFetchTransport, createSinkTransport } from "./transport.js";

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

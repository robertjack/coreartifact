// The weekly ping's gating and attempt logic (docs/issues/ISS-0023.md "The
// ping (R11)"). Pure with respect to time and delivery: `now` and
// `transport` are both injected, so tests/unit/ping/ covers never-pinged,
// inside-interval, outside-interval and a throwing transport without any
// clock skew or network dependency. The CLI-layer wiring (which transport
// to construct, whether to call this at all) lives in src/ping/index.ts,
// not here.
import { readState, appendPing } from "../core/operatorState.js";
import { PING_INTERVAL_MS, PING_ENDPOINT } from "./constants.js";
import type { PingTransport } from "./transport.js";

export interface MaybeSendPingOptions {
  statePath?: string;
  // Injectable clock — defaults to Date.now. Unit tests pin this to probe
  // the interval boundary without a real 7-day wait.
  now?: () => number;
  version: string;
  transport: PingTransport;
}

// Folds operator state, decides whether the weekly gate is open, and if so
// appends the `ping` op BEFORE firing the transport (packet: "Attempt-time
// recording is deliberate" — the gate closes whether or not delivery
// succeeds). A throwing/rejecting transport is swallowed entirely: no
// caller of this function ever sees it. Returns void — callers observe
// effects only through operator state and the transport's own side channel
// (e.g. the recording sink), never a return value.
export async function maybeSendPing(options: MaybeSendPingOptions): Promise<void> {
  const state = await readState(options.statePath);
  if (!state.consent) return;
  if (state.install_id === null) return; // no install id: nothing safe to send

  const now = options.now ? options.now() : Date.now();
  const lastPingAt = state.last_ping_at === null ? null : Date.parse(state.last_ping_at);
  // A never-pinged state, or an unparseable last_ping_at (never fabricated
  // as "recent" per the degradation law), counts as due.
  const isDue = lastPingAt === null || Number.isNaN(lastPingAt) || now - lastPingAt > PING_INTERVAL_MS;
  if (!isDue) return;

  await appendPing(options.statePath);

  try {
    await options.transport(PING_ENDPOINT, { version: options.version, install_id: state.install_id });
  } catch {
    // Fire-and-forget (packet "Fire-and-forget"): a transport error must
    // never change a command's stdout, stderr or exit code.
  }
}

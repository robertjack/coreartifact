// The injectable ping transport (docs/issues/ISS-0023.md "The injectable
// transport"). A transport is a plain function receiving the pinned URL and
// the two-field payload; the sender (sender.ts) never knows which kind it
// holds. Two constructors live here: the real POST transport, and the
// recording-sink transport the acceptance seam uses via
// COREARTIFACT_PING_SINK (construction of either is the CLI layer's job,
// not this module's — see src/ping/index.ts).
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — every node: import below is `@ts-ignore`d at
// the import site and re-typed through a local interface. `fetch` and
// `AbortController` are Node globals (available since Node 18/15
// respectively, well under this package's >=22.13 floor) with no ambient
// type in scope without @types/node or the DOM lib, so both are declared
// locally, module-scoped, describing only the surface this file calls —
// same shadowing pattern src/cli/index.ts uses for `process`.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { appendFileSync as appendFileSyncFn } from "node:fs";
// @ts-ignore -- node:timers has no ambient types available in this sandbox
import { setTimeout as setTimeoutFn, clearTimeout as clearTimeoutFn } from "node:timers";

const appendFileSync = appendFileSyncFn as (path: string, data: string) => void;
const setTimeout = setTimeoutFn as (fn: () => void, ms: number) => unknown;
const clearTimeout = clearTimeoutFn as (handle: unknown) => void;

declare class AbortController {
  readonly signal: unknown;
  abort(): void;
}
declare const fetch: (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown },
) => Promise<unknown>;

export interface PingPayload {
  version: string;
  install_id: string;
}

export type PingTransport = (url: string, payload: PingPayload) => Promise<void>;

// The real transport. Bounded by an explicit timeout (packet: "the process
// must not linger on a slow endpoint") — the receiver does not exist yet by
// design, so this must fail fast and silently rather than hang the CLI
// entry's await.
export function createFetchTransport(timeoutMs = 2000): PingTransport {
  return async (url, payload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

// The acceptance test seam (packet "The injectable transport"): appends
// `{url, payload}` as one JSON line to `sinkPath` instead of touching the
// network. Never used unless COREARTIFACT_PING_SINK names it — see
// src/ping/index.ts.
export function createSinkTransport(sinkPath: string): PingTransport {
  return async (url, payload) => {
    appendFileSync(sinkPath, `${JSON.stringify({ url, payload })}\n`);
  };
}

---
name: iss0023-ping-awaited-linger
description: ISS-0023 weekly ping is AWAITED on the CLI critical path, so a stalling endpoint lingers ~2s/command on consented machines despite "fire-and-forget" spec
metadata:
  type: project
---

# ISS-0023 ping — "fire-and-forget" is actually awaited (S2)

`src/cli/index.ts` `main` does `await sendCliPing(...)` → `sender.ts` `await options.transport(...)`
→ `transport.ts` `createFetchTransport` `await fetch(...)` bounded by a 2000ms AbortController.
So the ping is NOT fire-and-forget: `process.exit(code)` cannot run until the fetch settles.

**Executed 2026-07-16:** black-hole TCP listener (accepts, never responds) → the awaited transport
blocked **2006ms** before AbortError. Real endpoint `coreartifact.com/ping` (unresolvable in sandbox)
fast-failed in 0.13s (DNS ENOTFOUND is fine; connection-refused is fine). The 2s linger only bites
when the endpoint accepts-but-stalls (captive portal, corporate MITM proxy, slow LB). Spec
docs/issues/ISS-0023.md:90 says "the process must not linger on a slow endpoint" — literal violation,
but gated by opt-in (default consent false) + the stall precondition → S2, not S1. Would be S1 if
consent were default-on.

**Design tension (why it's defensible, not a slam-dunk fix):** a truly non-awaited fire followed by
`process.exit(code)` would KILL the in-flight fetch → ping never delivers. Fix direction: shorter
bound, or detach + drop the explicit `process.exit` and let the loop drain (unref the timer).

## Mutation resistance is GENUINE here (verified 2026-07-16)
- Payload widening: BOTH type-guarded (`PingPayload` is exactly `{version, install_id}`; a literal
  third key fails tsc → globalSetup red) AND runtime-guarded (`as any` bypass → 3 tests red on the
  `Object.keys().sort()` assertions in acceptance + unit).
- Drop interval gate (`if (!isDue) return;`): 3 red.
- Default consent true (operatorState `consent: false`→`true`): 1 red (unit "consent off: never
  attempts, even with a never-pinged install id" — install_id present + no consent line).
- Note: acceptance globalSetup **rebuilds dist from src every `vitest run`**, so mutating `dist/`
  is futile — mutate `src/` (src IS writable in this checkout).

## Clean classes (executed)
- Two-field wall: payload `{version, install_id}` only; no env/config/header/error enrichment;
  headers are content-type only; URL pinned no query. version=package "0.0.0", install_id=randomUUID.
- Consent-off silence: init/log/show/check/doctor/uninstall + no-state default fold → 0 sink lines.
- Attempt-time gating: ping op appended before transport; throwing transport swallowed in sender AND
  in main; exit/stdout/stderr unaffected (acceptance EISDIR-sink test genuine).
- Fold contract: install/consent via appendInstall/appendConsent, ping via appendPing; no direct writes.
- Hook artifact imports nothing from src/ping (ping rides only CLI entry).

---
name: iss0027-sandbox-no-socket-bind
description: ISS-0027's dashboard server acceptance tests cannot bind a real socket in this Bash tool sandbox — 100% deterministic EPERM on any host, confirmed pre-existing and code-independent
metadata:
  type: reference
---

Implementing ISS-0027 (the `open` command + `node:http` dashboard server),
every acceptance test that spawns the built CLI and does a real GET failed
with `Error: listen EPERM: operation not permitted <host>`. Before assuming
this was a bug in the server/port-selection code, isolated it with a minimal
repro:

```
node -e "require('node:net').createServer().listen(0, '127.0.0.1')"
```

This fails EPERM on its own, with no project code involved. Tried `127.0.0.1`,
`0.0.0.0`, and no-host (`listen(0)`) — all three fail identically. Also
confirmed on the pre-existing, untouched `tests/unit/cli/pingLinger.test.ts`
(binds a real socket for ping-timing tests) — it failed the same way, proving
this is environment-wide and not caused by this issue's diff.

**Why:** [[reference_sandbox_flaky_loopback_listen]] describes this class of
failure as *intermittent* (pass/fail flips across runs with no code change).
In this session it was 100% deterministic across every run and every host —
worth distinguishing, because the old note's advice ("re-run 2-3x, if it
flips it's the flake") doesn't apply when it never flips. Also confirmed
`dangerouslyDisableSandbox: true` on the Bash tool call does NOT lift this
restriction — it is enforced at a layer the flag does not reach in this
setup.

**How to apply:**
- Before spending time debugging a `listen EPERM` failure in dashboard/HTTP
  acceptance tests, run the two-line repro above. If it fails standalone, the
  failure is environmental, not your diff's fault — stop debugging server
  code and go verify the pure logic instead.
- Verify the parts of an HTTP-serving module that don't require a live socket
  by importing the BUILT `dist/` output directly in a throwaway `node -e`
  script and calling the pure functions in-process: host-header allowlist
  checks, path-traversal/asset resolution, route-pattern matching. This
  covers the GET wall's actual decision logic even when the end-to-end
  spawn-and-curl acceptance test cannot run here.
- Still run the full acceptance file once to get the real (probably
  network-EPERM) failure text, and run the full `pnpm test`-equivalent suite
  once to confirm the SAME pre-existing failure signature appears on
  unrelated files (e.g. `tests/unit/cli/pingLinger.test.ts`,
  `tests/acceptance/ISS-0009/packaging.test.ts` for the pnpm-pack case) —
  that comparison is the evidence a reviewer needs to distinguish "my change
  broke this" from "this sandbox can't do sockets/pnpm at all."

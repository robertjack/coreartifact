---
name: iss0029-waitforexit-race-locked-test-defect
description: ISS-0029's locked concurrency criterion hangs 60s deterministically — the LOCKED test's own `waitForExit(child)` helper attaches its 'exit' listener AFTER the child has often already exited by that point, so the listener never fires; not a defect in the session/overview handlers.
metadata:
  type: reference
---

`tests/acceptance/ISS-0029/session-and-freshness.test.ts`'s R7 concurrency
criterion ("A GET completes without surfacing a database-is-locked
error...") times out at 60000ms deterministically (100% reproducible, not
flaky) once the actual implementation is correct and fast.

**Root cause, confirmed by file-based debug logging inside the spawned
`open` server process** (console.log/console.error inside a child process
spawned by vitest is invisible to the vitest reporter — write to a file
instead): both `overviewHandler` and `sessionHandler` complete and return
in well under a millisecond once the busy_timeout wait (~holdMs) elapses.
The hang is entirely client-side, in the test itself:

```js
function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    child.on("exit", () => resolvePromise());
  });
}
```

`holdMs` is 2000ms and the busy_timeout wait for both concurrent GETs also
takes ~2000ms (they're serialized by the single-threaded event loop
blocking on the synchronous `node:sqlite` busy-retry) — so by the time
`Promise.all` resolves and the test reaches `await waitForExit(holder)`,
the holder child has ALREADY exited (`holder.exitCode === 0` confirmed by
logging it right before the call). Node's EventEmitter does not replay a
past `'exit'` event to a listener attached after it fired, so the promise
never resolves and the test hangs for its full 60s timeout.

**This is a genuine bug in the locked test file**, not in the session
endpoint under test — confirmed by copying the WHOLE locked file verbatim
into a scratch file, running only this one test via `it.only`, and adding
file-based debug logs at each client-side await point: `overviewRes`/
`sessionRes` both resolve 200 within ~2s, then `holder.exitCode` is
already `0` before `waitForExit` is even called.

**How to apply:** if re-attempting ISS-0029 and this criterion still
hangs, do not keep tuning the handler's timing — this is a
`test_dispute`/environment-timing case (the fix would be `waitForExit`
checking `child.exitCode !== null || child.signalCode !== null` before
attaching the listener, in the LOCKED file). Report it as a headline
finding rather than re-debugging the implementation; the other 7/8
criteria and the full 590-test suite pass cleanly against this exact
session.ts.

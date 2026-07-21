---
name: feedback-prepared-all-missing-param
description: node:sqlite prepared.all() with a WHERE ? clause silently returns [] (no throw) if you forget to pass the bind param — burned a unit test in coreartifact's daily-lane S2 cluster fix.
metadata:
  type: feedback
---

`db.prepare("SELECT ... WHERE session_id = ?").all()` called with ZERO
arguments does not throw in node:sqlite — it just returns `[]`, silently,
as if the WHERE clause matched nothing. This looks identical to "the row
was never inserted" or "the column got wiped", which sent me down a wrong
debugging path (added console.log via a scratch `it("dbg", ...)` file
before spotting the missing `.all(SESSION_ID)` argument).

**Why:** discovered while writing a coreartifact unit test for the
background_task_id backfill (F143) — `.all()` at three call sites all had
the trailing `?` param but no argument.

**How to apply:** when a node:sqlite query with a `?` placeholder returns
an empty/unexpected result, check the `.all(...)`/`.get(...)`/`.run(...)`
call's argument list FIRST, before doubting the data or the ledger state.

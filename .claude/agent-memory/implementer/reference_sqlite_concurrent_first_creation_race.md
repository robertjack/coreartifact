---
name: sqlite-concurrent-first-creation-race
description: node:sqlite DatabaseSync concurrency has THREE distinct failure modes beyond the well-known BEGIN-vs-BEGIN-IMMEDIATE one — readOnly connections need their own busy_timeout, and first-ever-creation races a rebuild-trigger probe into deleting a live writer's file.
metadata:
  type: reference
---

Fixing ISS-0017 F119 ("parallel check runs die 'database is locked'") took three
layered fixes, not one, on this codebase's node:sqlite (core/ledger.ts openLedger):

1. **BEGIN vs BEGIN IMMEDIATE** (the one reviewers usually name): a plain `BEGIN`
   (DEFERRED) transaction upgrades reader-to-writer on its first write statement,
   and that upgrade returns `SQLITE_BUSY` WITHOUT invoking the busy handler — so
   a `PRAGMA busy_timeout` set on the connection never applies to it. Use
   `BEGIN IMMEDIATE` to take the write lock at transaction start, where
   busy_timeout does apply.

2. **readOnly connections need busy_timeout too.** `new DatabaseSync(path,
   {readOnly: true})` still defaults busy_timeout to 0 — a reader can die
   "database is locked" the instant it opens while a writer holds the lock
   mid-commit, with zero wait. Every readOnly connection needs its own
   `db.exec('PRAGMA busy_timeout = ...')` right after opening — this repo has
   at least three (`check.ts`, `show.ts`, `resolve-session.ts`) that only some
   of which set it; grep before assuming it's covered.

3. **First-ever-creation race in the rebuild-trigger probe** (the deep one,
   only surfaces once #1 and #2 are fixed and you push concurrency past ~10
   processes racing a FRESH ledger with no pre-existing file): `openLedger`'s
   `needsRebuild` probe opens the path, and if it finds zero tables, treats that
   as "wrong schema, rebuild" and deletes the file. A brand-new SQLite file a
   concurrent process is still in the middle of creating (before its own
   `CREATE TABLE` lands) legitimately has zero tables for that instant — so a
   second process's probe reads that as "needs rebuild" and unlinks the file
   out from under the still-writing creator. The creator then throws — and the
   exact SQLite error text is NOT stable across repeated runs: observed
   "database is locked", "attempt to write a readonly database", and "disk I/O
   error" for the literal same race on the literal same machine, just different
   points where the C layer notices the file vanished. Enumerating error
   strings is a losing game — if you can't touch the file that owns
   `needsRebuild` (out of footprint), the working fix is: retry the WHOLE
   `openLedger` call with backoff, on ANY error except the one truly
   non-racy, definitive one (`LedgerPathIsDirectoryError`). On retry the
   winning process's file is either fully created (ordinary open) or fully
   gone again (this call becomes the creator) — never caught mid-flight twice
   in a row in practice.

**How to prove #3 exists at all**: a concurrency test that pre-creates the
ledger (one `log`/ingest before the concurrent burst) will pass with just
fixes #1+#2 — the race is invisible unless the test hits a ledger that has
never been created before. Test the REAL fleet workload (first-ever concurrent
readers/writers against a fresh repo), not a warmed one, or you'll ship a fix
that only handles the steady state.

See [[totality-and-concurrency-test-patterns]] for the "spawn real processes"
half of this; this note is the SQLite-specific half.

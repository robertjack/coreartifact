# Stubs guarding a later issue's surface must be distinguishable from success

**What happened (PRD-0003, ISS-0027→ISS-0029):** the server-core issue
shipped `/api/session/<id>` as a stub returning a valid-shaped success
(`200 {}`) so the GET wall was testable before the endpoint issue. One
issue later, the session-endpoint criterion "a full browse … returns
200" was GREEN against that stub — red-verify refused it as
mapped-but-green TWICE (two test-author rounds, $7.71), the ladder
terminated `test_author_defect`, and the rescue was an operator
amendment pinning the response body. The audit was right both times;
the trap was planted at decompose time.

**Why:** a valid-shaped success stub turns every downstream
"returns 200" / "responds successfully" assertion vacuous. The
test-author cannot fix this by trying harder — the criterion's only
red-able delta is the response *content*, which the criterion text may
not name.

**How to apply:** when a plan stages one issue's surface behind an
earlier issue's stub, the stub must be distinguishable from success —
`501`, or a marked body (`{"stub": true}`) — OR the downstream issue's
criteria must pin content the stub cannot satisfy (name the field, not
the status). State which in both issue specs at decompose time. Related:
[[feedback_footprint_locked_surfaces_sizing]].

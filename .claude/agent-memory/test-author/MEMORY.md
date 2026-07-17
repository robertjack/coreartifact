# Test-author memory — coreartifact

- [Criteria are deltas, not invariants](feedback_criteria_are_deltas_not_invariants.md)
- [Locked tests are contract](feedback_locked_test_contract.md) — imports come from the footprint's owns block; red must be the criterion's red, not MODULE_NOT_FOUND; never read env truths after overriding them; containment over exact pins (gotchas #7). 4 of PRD-0002's 7 escalations, zero implementation faults. — red-verify executes your mapped tests at the issue's BASE; any green mapping is bounced as a test_author_defect. Prove red before submitting.

// Binding resolution (pure) — docs/issues/ISS-0017.md "Binding". Resolved
// ONCE at check time against the repo ledger's then-current open-session
// set, in this order:
//
//   1. `--session <id>` given and the id exists in the ledger -> bind,
//      bound_by "explicit". Unknown id -> a typed failure naming it.
//   2. Exactly one open session -> bind to it, bound_by "single-open".
//   3. Zero or several open -> standalone (session_id null, bound_by null)
//      -- never a guess (the honest-N/A shape, docs/gotchas.md entry 5).
//
// No I/O — the seam tests/unit/check/binding.test.ts exercises directly
// over an in-memory open-session set.

export type BoundBy = "single-open" | "explicit";

export interface ResolveBindingInput {
  explicitSessionId?: string;
  openSessionIds: string[];
  knownSessionIds: Set<string>;
}

export type ResolveBindingResult =
  | { ok: true; sessionId: string | null; boundBy: BoundBy | null }
  | { ok: false; unknownSessionId: string };

export function resolveBinding(input: ResolveBindingInput): ResolveBindingResult {
  if (input.explicitSessionId !== undefined) {
    if (!input.knownSessionIds.has(input.explicitSessionId)) {
      return { ok: false, unknownSessionId: input.explicitSessionId };
    }
    return { ok: true, sessionId: input.explicitSessionId, boundBy: "explicit" };
  }

  if (input.openSessionIds.length === 1) {
    return { ok: true, sessionId: input.openSessionIds[0]!, boundBy: "single-open" };
  }

  return { ok: true, sessionId: null, boundBy: null };
}

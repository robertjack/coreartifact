// The absent marker — one shared, unmistakable token for every ABSENT
// facet (docs/issues/ISS-0007.md "The absent marker (shared surface)").
// `log` owns this module; `show` imports it rather than re-deriving its
// own token. Never a blank column, a dash, or "0" — those already mean
// something else (unset, no rows, zero-of-something). A drift-fallback
// ABSENT kind, a never-captured sha, or any other missing facet all render
// through this one function so the two renderers can never disagree.
export const ABSENT_MARKER = "‹absent›";

export function renderAbsent(value: string | null | undefined): string {
  return value === null || value === undefined || value.length === 0 ? ABSENT_MARKER : value;
}

// The derived-value marker (docs/issues/ISS-0019.md "Render") — a cost
// figure is computed from the pinned price table, not observed off the
// spool, so it renders visibly distinct from every spool-borne facet on the
// same line. ABSENT still goes through the shared absent marker above
// (never blank, never zero) with no derived annotation, since there is no
// value to label as computed.
export function renderCostUsd(costUsd: number | null): string {
  return costUsd === null ? ABSENT_MARKER : `${costUsd} (derived)`;
}

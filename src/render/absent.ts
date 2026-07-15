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

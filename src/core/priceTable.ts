// The pinned per-model price table (docs/issues/ISS-0019.md, gate ruling
// 2026-07-16) — a fragile-dependency register entry in its own right, never
// schema. No dollar figure exists anywhere in a transcript: cost_usd is
// always computed from these rates times the token counts enrichment
// parses. Pin exact model id strings only, never aliases (repo law) — an
// id absent from this table is DELIBERATELY unpinned (an intro-pricing
// window, or no oracle recording) and must degrade to cost-ABSENT, never a
// guessed rate.
//
// Do NOT re-derive these numbers: the three committed envelope oracles are
// 3 equations over 4+ unknowns and underdetermine the table on their own
// (the gate ruling is the only source). All rates are USD per million
// tokens ("MTok").

export interface ModelRate {
  in: number;
  out: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
}

const MICROS_PER_MTOK = 1_000_000;

const PRICE_TABLE: Readonly<Record<string, ModelRate>> = {
  "claude-fable-5": { in: 10.0, out: 50.0, cacheRead: 1.0, write5m: 12.5, write1h: 20.0 },
  "claude-haiku-4-5-20251001": { in: 1.0, out: 5.0, cacheRead: 0.1, write5m: 1.25, write1h: 2.0 },
  // claude-sonnet-5, pinned 2026-07-20 (daily-lane, observed-tier validation
  // — house law: observed truth over documentation, CLAUDE.md). Documented
  // pricing names TWO tiers effective now: standard $3.00/$15.00 per MTok,
  // and an introductory $2.00/$10.00 tier stated to run through
  // 2026-08-31. Observation overrides the documented intro window: 7
  // real aeh worker attempts (session ids f60a4043, 4af91a7c, 8fc93fd5,
  // a0e792c9, e5d1454c, 642aad37, 3b861cb6 — cross-referenced between
  // .coreartifact/ledger.db sessions.tokens_* [the ISS-0019 dedup-parsed
  // counts] and .aeh/aeh.db attempts.cost_usd [the envelope oracle]) all
  // solve EXACTLY for the STANDARD tier with 100% of cache-creation billed
  // at the 1h TTL rate (write1h = 6.00, i.e. base_std := in*3 + out*15 +
  // cacheRead*0.3; in every one of the 7 pairs, (cost*1e6 - base_std) /
  // cacheCreationTokens == 6.0 to the observed decimal, zero residual).
  // The intro tier does not fit any pair under any 5m/1h mix (residual
  // rate exceeds even its own 1h max). Structural rule holds at the
  // standard tier's own multiples (cacheRead = 0.1x in, write5m = 1.25x
  // in, write1h = 2x in) — same shape as the other two pinned rows, just
  // the higher of the two documented tiers. If the intro tier turns out to
  // start billing later (2026-08-31 boundary) or sooner for other
  // accounts, doctor's fragile-dependency drift check is the mechanism to
  // catch it — this pin is not meant to survive silently past that date
  // unchecked.
  "claude-sonnet-5": { in: 3.0, out: 15.0, cacheRead: 0.3, write5m: 3.75, write1h: 6.0 },
};

/** The pinned rate for an exact model id string, or null when deliberately unpinned. */
export function lookupModelRate(model: string): ModelRate | null {
  return PRICE_TABLE[model] ?? null;
}

export interface TokenUsageForPricing {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
}

/**
 * The pre-division dollar numerator (sum of token-class * rate, still in
 * "USD * MTok" units) for one model's rate over one usage bundle. Exposed
 * so a caller pricing PER REQUEST across a mixed-model transcript (F127,
 * ISS-0019 review) can sum numerators across requests and divide by
 * MICROS_PER_MTOK exactly once at the end — dividing once per request and
 * then summing the already-divided USD figures introduces floating-point
 * drift that breaks exact-oracle reproduction on a single-model transcript
 * (a mixed transcript is just N>=1 requests, so the two paths must agree
 * bit-for-bit when N==1). Returns null when the model has no pinned rate.
 */
export function computeCostNumerator(model: string, usage: TokenUsageForPricing): number | null {
  const rate = lookupModelRate(model);
  if (rate === null) return null;
  return (
    usage.inputTokens * rate.in +
    usage.outputTokens * rate.out +
    usage.cacheReadTokens * rate.cacheRead +
    usage.cacheCreation5mTokens * rate.write5m +
    usage.cacheCreation1hTokens * rate.write1h
  );
}

/**
 * Cost = sum over the token classes times the per-class rate for the given
 * model, in USD. Cache writes price by TTL (the 5m/1h split), never the
 * single display-aggregation cache-creation figure. Returns null when the
 * model has no pinned rate — the caller degrades cost to ABSENT, never to
 * zero or an estimate.
 */
export function computeCostUsd(model: string, usage: TokenUsageForPricing): number | null {
  const numerator = computeCostNumerator(model, usage);
  return numerator === null ? null : numerator / MICROS_PER_MTOK;
}

/** Divides a summed dollar numerator (see computeCostNumerator) into USD, exactly once. */
export function numeratorToUsd(numerator: number): number {
  return numerator / MICROS_PER_MTOK;
}

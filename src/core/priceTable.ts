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

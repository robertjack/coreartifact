// Cost enrichment — the one transcript-derived facet, fail-soft
// (docs/issues/ISS-0019.md). Pure parse + price computation over the
// transcript file at a session's recorded transcript path, read in place
// and never copied (law: no transcript column exists, no byte is cached).
//
// The transcript JSONL schema is documented-as-internal and can drift on
// any Claude Code release, so every branch here fails soft: ABSENT with a
// named reason from the closed absence-reason vocabulary (src/core/absence.ts),
// never zero, never estimated, never a thrown error the caller must guard
// against — enrichFromTranscript is total.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:fs import below is `@ts-ignore`d at the
// import site and re-typed through a local interface.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { readFileSync as readFileSyncFn } from "node:fs";
import { computeCostNumerator, numeratorToUsd } from "../core/priceTable.js";
import { COST_ABSENCE_REASONS, type CostAbsenceReason } from "../core/absence.js";

const readFileSync = readFileSyncFn as (path: string, encoding: string) => string;

// Claude Code's own synthetic placeholder model id, observed 2026-07-20
// (daily-lane) in two real transcripts under
// ~/.claude/projects/-Users-robbiejack-dev-coreartifact/ (30eb6167...,
// 7cdc9d81...): a rate-limit error line ("You've hit your weekly/session
// limit") the CLI itself inserts as an assistant turn, with
// `message.model === "<synthetic>"` and every usage field (input, output,
// cache read, cache creation, both TTL splits) zero. It carries no real
// request cost. Left in the per-request all-or-nothing pinning set, this
// non-model id (never pinnable — it names no billable model) would
// unpin the WHOLE session's cost even though it contributes nothing
// numerically; the live ledger shows exactly this happening for session
// 7cdc9d81-c46d-4126-b325-240683775f93 (real tokens present, cost/model
// both NULL, absence reason "model unpinned: <synthetic>"). Excluded here
// from cost pricing AND from the displayed-model set — real requests in
// the same transcript price and display normally.
const SYNTHETIC_MODEL = "<synthetic>";

export interface EnrichmentResult {
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensCacheRead: number | null;
  tokensCacheCreation: number | null;
  costUsd: number | null;
  model: string | null;
  ccVersion: string | null;
  // null when enriched (no degradation) or when the facet was never
  // touched by absence at all (mirrors AbsenceRow's own closed vocabulary).
  costAbsenceReason: CostAbsenceReason | null;
}

interface RequestUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  // Display aggregation (schema.md's single tokens_cache_creation column) —
  // read directly from the transcript's own aggregate field, never derived
  // by re-summing the 5m/1h split (those are the pricing input, not the
  // display value, even though they happen to sum to the same figure).
  cacheCreationTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absentResult(reason: CostAbsenceReason): EnrichmentResult {
  return {
    tokensInput: null,
    tokensOutput: null,
    tokensCacheRead: null,
    tokensCacheCreation: null,
    costUsd: null,
    model: null,
    ccVersion: null,
    costAbsenceReason: reason,
  };
}

// Parses one assistant transcript line into its pricing shape, or null when
// the line doesn't carry the pinned fields (requestId, message.model,
// message.usage with all four token classes plus the cache-creation TTL
// split) — the drift signal: a transcript whose assistant lines are missing
// `message.usage` entirely (the acceptance suite's hand-authored drift case)
// yields null for every line here.
function extractRequestUsage(
  line: Record<string, unknown>,
): { requestId: string; model: string; usage: RequestUsage } | null {
  const requestId = line.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) return null;

  const message = line.message;
  if (!isRecord(message)) return null;

  const model = message.model;
  if (typeof model !== "string" || model.length === 0) return null;

  const usage = message.usage;
  if (!isRecord(usage)) return null;
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = usage;
  if (
    typeof input_tokens !== "number" ||
    typeof output_tokens !== "number" ||
    typeof cache_read_input_tokens !== "number" ||
    typeof cache_creation_input_tokens !== "number"
  ) {
    return null;
  }

  const cacheCreation = usage.cache_creation;
  if (!isRecord(cacheCreation)) return null;
  const { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } = cacheCreation;
  if (typeof ephemeral_5m_input_tokens !== "number" || typeof ephemeral_1h_input_tokens !== "number") {
    return null;
  }

  return {
    requestId,
    model,
    usage: {
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      cacheReadTokens: cache_read_input_tokens,
      cacheCreationTokens: cache_creation_input_tokens,
      cacheCreation5mTokens: ephemeral_5m_input_tokens,
      cacheCreation1hTokens: ephemeral_1h_input_tokens,
    },
  };
}

/**
 * Enriches one session's cost/token facet from its transcript, read in
 * place at `transcriptPath` (null when no event named a transcript path at
 * all — treated the same as an unreadable file: transcript unavailable).
 * Total: every branch returns, never throws.
 */
export function enrichFromTranscript(transcriptPath: string | null): EnrichmentResult {
  if (transcriptPath === null) {
    return absentResult(COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
  }

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return absentResult(COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  let ccVersion: string | null = null;
  let assistantLineCount = 0;
  // Multiple assistant lines repeat one request's usage under a shared
  // requestId (docs/issues/ISS-0019.md) — dedup by requestId, first
  // occurrence wins (observed identical across repeats), sum across
  // distinct requests only.
  const byRequestId = new Map<string, { model: string; usage: RequestUsage }>();

  for (const lineText of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lineText);
    } catch {
      continue; // tolerate the zoo: an unparseable physical line contributes nothing
    }
    if (!isRecord(parsed)) continue;

    if (ccVersion === null && typeof parsed.version === "string" && parsed.version.length > 0) {
      ccVersion = parsed.version;
    }

    // Unknown transcript line types (system, attachment, file-history-snapshot,
    // mode, ai-title, and anything future) are skipped silently — parse only
    // what is pinned.
    if (parsed.type !== "assistant") continue;
    assistantLineCount++;

    const extracted = extractRequestUsage(parsed);
    if (extracted === null) continue;
    if (!byRequestId.has(extracted.requestId)) {
      byRequestId.set(extracted.requestId, { model: extracted.model, usage: extracted.usage });
    }
  }

  // A readable transcript with assistant lines present but none of them
  // parsing to the pinned shape (or no assistant lines at all) is drift, not
  // absence-of-usage: the shape itself is outside the pinned parse.
  if (assistantLineCount === 0 || byRequestId.size === 0) {
    return { ...absentResult(COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED), ccVersion };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let cacheCreation5mTokens = 0;
  let cacheCreation1hTokens = 0;
  const distinctModels = new Set<string>();

  // Pricing is per-request: each request's own `.message.model` prices ONLY
  // that request's own usage (F127, ISS-0019 review) — a mixed-model
  // transcript (subagents, /model switches, plan-mode differences all land
  // in one transcript file) must never collapse to "price everything at the
  // first request's model", which either fabricates a wildly wrong total
  // (pinned model[0], unpinned/expensive model later) or discards a
  // dominant pinned model's cost (unpinned model[0]). Costs sum across
  // requests; the moment ANY usage-carrying request's model is unpinned,
  // the whole cost degrades to ABSENT (all-or-nothing — partial pricing
  // would itself be a fabricated figure) naming the FIRST unpinned model
  // encountered, in file order. Token counts are price-independent and
  // always sum in full regardless.
  // Numerators (pre-division "USD * MTok" units) sum across requests and
  // divide by MICROS_PER_MTOK exactly once at the end (numeratorToUsd) —
  // dividing per request first would introduce floating-point drift that
  // breaks the committed single-model oracles' exact-digit reproduction,
  // since a single-model transcript is just the N==1 case of this same sum.
  let costNumerator: number | null = 0;
  let firstUnpinnedModel: string | null = null;

  for (const { model: requestModel, usage } of byRequestId.values()) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheCreationTokens += usage.cacheCreationTokens;
    cacheCreation5mTokens += usage.cacheCreation5mTokens;
    cacheCreation1hTokens += usage.cacheCreation1hTokens;

    // The synthetic placeholder never names a real, billable model — skip
    // it for both pricing and the displayed-model set entirely (see
    // SYNTHETIC_MODEL above). Its own usage is always observed zero, so
    // this changes no token sum; it only stops it from poisoning the
    // all-or-nothing cost pin for the transcript's real requests.
    if (requestModel === SYNTHETIC_MODEL) continue;
    distinctModels.add(requestModel);

    if (costNumerator === null) continue; // already degraded; keep summing tokens only
    const requestNumerator = computeCostNumerator(requestModel, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreation5mTokens: usage.cacheCreation5mTokens,
      cacheCreation1hTokens: usage.cacheCreation1hTokens,
    });
    if (requestNumerator === null) {
      costNumerator = null;
      firstUnpinnedModel = requestModel;
    } else {
      costNumerator += requestNumerator;
    }
  }

  const costUsd = costNumerator === null ? null : numeratorToUsd(costNumerator);

  // model column: a single distinct model across the transcript's requests
  // is recorded; a mix has no single "the model" to display (a lone value
  // would misinform), so it stores NULL — distinct from the unpinned-cost
  // degradation above, which is about pricing, not this display field.
  const model = distinctModels.size === 1 ? [...distinctModels][0] : null;

  return {
    tokensInput: inputTokens,
    tokensOutput: outputTokens,
    tokensCacheRead: cacheReadTokens,
    tokensCacheCreation: cacheCreationTokens,
    costUsd,
    model,
    ccVersion,
    costAbsenceReason: costUsd === null && firstUnpinnedModel !== null
      ? COST_ABSENCE_REASONS.modelUnpinned(firstUnpinnedModel)
      : null,
  };
}

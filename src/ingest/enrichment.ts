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
import { computeCostUsd } from "../core/priceTable.js";
import { COST_ABSENCE_REASONS, type CostAbsenceReason } from "../core/absence.js";

const readFileSync = readFileSyncFn as (path: string, encoding: string) => string;

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
  let model: string | null = null;

  for (const { model: requestModel, usage } of byRequestId.values()) {
    if (model === null) model = requestModel;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheCreationTokens += usage.cacheCreationTokens;
    cacheCreation5mTokens += usage.cacheCreation5mTokens;
    cacheCreation1hTokens += usage.cacheCreation1hTokens;
  }

  const costUsd =
    model !== null
      ? computeCostUsd(model, {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreation5mTokens,
          cacheCreation1hTokens,
        })
      : null;

  return {
    tokensInput: inputTokens,
    tokensOutput: outputTokens,
    tokensCacheRead: cacheReadTokens,
    tokensCacheCreation: cacheCreationTokens,
    costUsd,
    model,
    ccVersion,
    costAbsenceReason: costUsd === null && model !== null ? COST_ABSENCE_REASONS.modelUnpinned(model) : null,
  };
}

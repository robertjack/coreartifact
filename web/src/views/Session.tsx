import { useEffect, useState } from "react";
import type { SessionViewResponse } from "../api-types";
import {
  checkBadge,
  facetHeader,
  facetMarker,
  footprintView,
  testFacet,
  timelineRow,
  type FacetHeaderRow,
  type FacetMarker,
} from "./session/model";
import { fmtDate, fmtDuration, fmtMoney, shortSha } from "./session/format";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: SessionViewResponse };

const FACET_LABELS: Record<string, string> = {
  session_id: "Session",
  repo_root: "Repo",
  worktree_path: "Worktree",
  status: "Status",
  kind: "Kind",
  sha_before: "SHA before",
  sha_after: "SHA after",
  model: "Model",
  cc_version: "CC version",
  started_at: "Started",
  last_event_at: "Last event",
  ended_at: "Ended",
};

function DisclosureChip({ reason }: { reason: string }) {
  return (
    <details className="inline-block rounded-full border border-amber-200 bg-amber-50 align-middle text-[11px] text-amber-700">
      <summary className="cursor-pointer list-none px-2 py-0.5 font-bold marker:content-none">ABSENT</summary>
      <div className="max-w-xs px-2 pb-1 text-amber-700">{reason}</div>
    </details>
  );
}

function QuietDash() {
  return <span className="text-zinc-400">—</span>;
}

function facetValueLabel(key: string, value: unknown): string {
  if (key === "started_at" || key === "last_event_at" || key === "ended_at") {
    return fmtDate(value as string);
  }
  if (key === "sha_before" || key === "sha_after") {
    return shortSha(value as string);
  }
  if (key === "worktree_path" && value === null) {
    return "main checkout";
  }
  return String(value);
}

function FacetCell({ row }: { row: FacetHeaderRow }) {
  const label = FACET_LABELS[row.key] ?? row.key;
  let content: React.ReactNode;
  if (row.marker.type === "disclosure") {
    content = <DisclosureChip reason={row.marker.reason} />;
  } else if (row.marker.type === "quiet") {
    content = <QuietDash />;
  } else {
    content = <span>{facetValueLabel(row.key, row.marker.value)}</span>;
  }
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="truncate text-sm font-semibold text-zinc-900">{content}</div>
    </div>
  );
}

function DerivedTile({
  label,
  marker,
  format,
  unit,
}: {
  label: string;
  marker: FacetMarker;
  format: (value: unknown) => string;
  unit?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-xl font-bold tabular-nums">
        {marker.type === "disclosure" ? (
          <DisclosureChip reason={marker.reason} />
        ) : (
          <>
            {marker.type === "present" ? format(marker.value) : "—"}
            {unit ? <span className="ml-1 text-xs font-normal text-zinc-400">{unit}</span> : null}
          </>
        )}
        <span className="ml-1 rounded border border-zinc-200 px-1 text-[9px] font-normal text-zinc-400">derived</span>
      </div>
    </div>
  );
}

export default function Session({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const repo = new URLSearchParams(window.location.search).get("repo");
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
    fetch(`/api/session/${encodeURIComponent(sessionId)}${qs}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`session request failed: ${res.status}`);
        const data = (await res.json()) as SessionViewResponse;
        if (!cancelled) setState({ status: "loaded", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (state.status === "loading") {
    return (
      <div className="space-y-4">
        <div className="h-32 animate-pulse rounded-lg border border-zinc-200 bg-white" />
        <div className="h-48 animate-pulse rounded-lg border border-zinc-200 bg-white" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mx-auto max-w-md rounded-lg border border-zinc-200 bg-white p-10 text-center">
        <h2 className="mb-1 text-base font-semibold">Couldn't load the session</h2>
        <p className="text-sm text-zinc-500">{state.message}</p>
      </div>
    );
  }

  const { data } = state;
  const headerRows = facetHeader(data.facets, data.absences);
  const test = testFacet(data.test_results);
  const footprint = footprintView(data.footprint);
  const rows = data.timeline.map(timelineRow);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-6">
        <div className="mb-4 text-xs font-bold uppercase tracking-wide text-zinc-500">Session facets</div>
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4">
          {headerRows.map((row) => (
            <FacetCell key={row.key} row={row} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <DerivedTile
          label="Cost"
          marker={facetMarker("cost", data.facets.cost.value, data.absences)}
          format={(v) => fmtMoney(v as number)}
        />
        <DerivedTile
          label="Tokens"
          marker={facetMarker("tokens", data.facets.tokens.input, data.absences)}
          format={() => `${data.facets.tokens.input}/${data.facets.tokens.output}`}
          unit="in/out"
        />
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">Checks</div>
        {data.checks.length === 0 ? (
          <div className="text-sm text-zinc-400">No bound checks</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.checks.map((check) => {
              const badge = checkBadge(check);
              return (
                <span
                  key={badge.name}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${
                    badge.state === "passed"
                      ? "border-green-200 bg-green-50 text-green-700"
                      : "border-red-200 bg-red-50 text-red-700"
                  }`}
                >
                  {badge.name} · {badge.state}
                  {badge.truncated ? <span className="text-zinc-400">(truncated)</span> : null}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">Test results</div>
        {test.type === "absent" ? (
          <div className="text-sm text-zinc-400">ABSENT — no command claimed by a parser</div>
        ) : (
          <div className="space-y-1">
            {test.rows.map((row) => (
              <div key={row.line_no} className="flex gap-4 text-sm">
                <span className="font-mono text-xs text-zinc-400">{row.parser}</span>
                <span className="text-green-700">{row.passed} passed</span>
                <span className="text-red-700">{row.failed} failed</span>
                <span className="text-zinc-500">{row.skipped} skipped</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
          Footprint ({footprint.length})
        </div>
        {footprint.length === 0 ? (
          <div className="text-sm text-zinc-400">No files touched</div>
        ) : (
          <ul className="space-y-0.5 font-mono text-xs text-zinc-700">
            {footprint.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        )}
      </div>

      {data.absences.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          <div className="mb-1 text-xs font-bold uppercase tracking-wide text-amber-700">Absences</div>
          <ul className="space-y-0.5 text-amber-700">
            {data.absences.map((a) => (
              <li key={a.facet}>
                <span className="font-mono">{a.facet}</span>: {a.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">Timeline</div>
        <div className="divide-y divide-zinc-100">
          {rows.map((row, i) => (
            <div key={i} className="flex items-start gap-3 py-2 text-sm">
              <span className="w-24 shrink-0 font-mono text-[11px] text-zinc-400">
                {row.ts ? fmtDate(row.ts) : ""}
              </span>
              <span className="w-20 shrink-0 rounded border border-zinc-200 px-1.5 py-0.5 text-center text-[10px] font-bold uppercase text-zinc-500">
                {row.kind}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {row.kind === "lifecycle" || row.kind === "subagent" ? row.hookEventName : null}
                {row.kind === "prompt" ? row.prompt : null}
                {row.kind === "command" ? row.command : null}
              </span>
              {row.kind === "command" && (
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                    row.outcome === "success"
                      ? "border-green-200 bg-green-50 text-green-700"
                      : row.outcome === "failure"
                        ? "border-red-200 bg-red-50 text-red-700"
                        : "border-amber-200 bg-amber-50 text-amber-700"
                  }`}
                  title={row.outcomeError ?? undefined}
                >
                  {row.outcome ?? "absent"}
                </span>
              )}
              {row.kind === "command" && row.durationMs != null && (
                <span className="shrink-0 text-xs text-zinc-400">{fmtDuration(row.durationMs)}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { OverviewResponse } from "../api-types";
import {
  barSegments,
  driftBanner,
  headline,
  repoRow,
  reposSkippedNotice,
  sessionRow,
  spendTile,
} from "./overview/model";
import { fmtDate, fmtMoney, shortId } from "./overview/format";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: OverviewResponse };

function badgeClass(badge: string | null): string {
  switch (badge) {
    case "verified":
      return "border-green-200 bg-green-50 text-green-700";
    case "failing":
      return "border-red-200 bg-red-50 text-red-700";
    case "unverified":
      return "border-zinc-200 bg-zinc-100 text-zinc-500";
    default:
      return "";
  }
}

function kindBadgeClass(kind: string | null): string {
  if (kind === "headless") return "border-indigo-200 bg-indigo-50 text-indigo-700";
  if (kind === "interactive") return "border-cyan-200 bg-cyan-50 text-cyan-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

export default function Overview() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/overview")
      .then(async (res) => {
        if (!res.ok) throw new Error(`overview request failed: ${res.status}`);
        const data = (await res.json()) as OverviewResponse;
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
  }, []);

  if (state.status === "loading") {
    return (
      <div className="space-y-4">
        <div className="h-32 animate-pulse rounded-lg border border-zinc-200 bg-white" />
        <div className="grid grid-cols-3 gap-4">
          <div className="h-20 animate-pulse rounded-lg border border-zinc-200 bg-white" />
          <div className="h-20 animate-pulse rounded-lg border border-zinc-200 bg-white" />
          <div className="h-20 animate-pulse rounded-lg border border-zinc-200 bg-white" />
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mx-auto max-w-md rounded-lg border border-zinc-200 bg-white p-10 text-center">
        <h2 className="mb-1 text-base font-semibold">Couldn't load the overview</h2>
        <p className="text-sm text-zinc-500">{state.message}</p>
      </div>
    );
  }

  const { data } = state;
  const { kpi, tiles, sessions, repos, repos_skipped, drift, window: win } = data;

  const bar = barSegments(kpi);
  const banners = driftBanner(drift);
  const spend = spendTile(tiles);
  const skipped = reposSkippedNotice(repos_skipped);
  const unreadableEntries = repos.filter((r) => r.status === "unreadable");
  const isEmpty = repos.length === 0;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-6">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
          Overview · verified-delegation share
        </div>
        <div className="mb-3 text-2xl font-bold tracking-tight">
          {headline(kpi)} delegated sessions verified
        </div>
        <div className="mb-3 flex h-3 overflow-hidden rounded-full bg-zinc-100">
          {bar.empty ? (
            <div className="h-full w-full" />
          ) : (
            bar.segments.map((seg) => (
              <div
                key={seg.key}
                className={
                  seg.key === "verified"
                    ? "h-full bg-green-500"
                    : seg.key === "failing"
                      ? "h-full bg-red-500"
                      : "h-full bg-zinc-300"
                }
                style={{ width: `${seg.widthPct}%` }}
              />
            ))
          )}
        </div>
        <div className="flex flex-wrap gap-4 text-xs">
          <span>
            <b className="tabular-nums">{kpi.verified}</b> verified
          </span>
          <span>
            <b className="tabular-nums">{kpi.failing}</b> failing
          </span>
          <span>
            <b className="tabular-nums">{kpi.unverified}</b> unverified
          </span>
        </div>
        {kpi.unknown_kind > 0 && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
            {kpi.unknown_kind} session{kpi.unknown_kind === 1 ? "" : "s"} of unknown kind — excluded from the
            delegated count above, never silently folded in.
          </div>
        )}
        <div className="mt-3 text-[11px] text-zinc-400">
          Rolling {win.days}-day window (local): {fmtDate(win.start)} – {fmtDate(win.end)}
        </div>
      </div>

      {banners &&
        banners.map((b) => (
          <div key={b.session} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
            <b className="text-amber-700">Drift banner</b> — session <span className="font-mono">{shortId(b.session)}</span>{" "}
            recorded Claude Code <span className="font-mono">{b.version}</span>, outside the tested range{" "}
            <span className="font-mono">{b.range}</span>.
          </div>
        ))}

      {unreadableEntries.map((r) => {
        const row = repoRow(r);
        return (
          <div key={r.root} className="rounded-lg border border-zinc-200 bg-white p-3 text-sm">
            {repos.length - unreadableEntries.length} of {repos.length} registered repos readable —{" "}
            <span className="font-mono">{r.root}</span> is <b>unreadable</b>: {row.reason}
          </div>
        );
      })}

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">Spend (present)</div>
          <div className="text-xl font-bold tabular-nums">
            {fmtMoney(spend.valueUsd)}
            <span className="ml-1 rounded border border-zinc-200 px-1 text-[9px] font-normal text-zinc-400">
              derived
            </span>
          </div>
          <div className={`text-xs ${spend.absentNote ? "font-semibold text-amber-600" : "text-zinc-500"}`}>
            {spend.absentNote ?? "present for every session"}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">Sessions by kind</div>
          <div className="text-xl font-bold tabular-nums">
            {tiles.sessions_by_kind.headless + tiles.sessions_by_kind.interactive + tiles.sessions_by_kind.unknown}
          </div>
          <div className="flex gap-2 text-xs text-zinc-500">
            <span>{tiles.sessions_by_kind.headless} headless</span>
            <span>{tiles.sessions_by_kind.interactive} interactive</span>
            <span>{tiles.sessions_by_kind.unknown} unknown</span>
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">Failing bound checks</div>
          <div className="text-xl font-bold tabular-nums">{tiles.failing_checks}</div>
          <div className="text-xs text-zinc-500">in-window, session-bound only</div>
        </div>
      </div>

      {isEmpty ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-10 text-center">
          <h2 className="mb-1 text-base font-semibold">No registered repos yet</h2>
          <p className="text-sm text-zinc-500">
            Run <code className="font-mono">coreartifact init</code> in a repo to register its ledger. The overview
            renders honest zeros until then — never a blank screen.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between px-1">
            <h2 className="text-sm font-semibold">Sessions</h2>
            <span className="text-xs text-zinc-500">
              Showing latest {sessions.latest.length} of {sessions.total} ·{" "}
              {skipped.visible ? `${skipped.count} corrupt registry line(s) skipped` : "0 corrupt registry lines skipped"}
            </span>
          </div>
          <div className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
            {sessions.latest.map((entry) => {
              const row = sessionRow(entry);
              return (
                <a
                  key={row.sessionId}
                  href={row.href}
                  className="flex items-center gap-4 p-3 text-left hover:bg-zinc-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{shortId(row.sessionId)}</span>
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${kindBadgeClass(row.kind ?? null)}`}>
                        {row.kind ?? "unknown"}
                      </span>
                      {row.badge != null && (
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${badgeClass(row.badge)}`}>
                          {row.badge}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2 text-xs text-zinc-500">
                      <span>{row.repoRoot.split("/").pop()}</span>
                      <span>·</span>
                      <span>{row.status}</span>
                    </div>
                  </div>
                  <div className="min-w-[74px] text-right text-sm font-semibold">
                    {row.cost && row.cost.value != null ? fmtMoney(row.cost.value) : <span className="text-zinc-400">—</span>}
                  </div>
                  <div className="min-w-[96px] text-right text-xs text-zinc-400">
                    {row.startedAt ? fmtDate(row.startedAt) : null}
                  </div>
                </a>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

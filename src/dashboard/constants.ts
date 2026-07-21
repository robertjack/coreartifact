// Dashboard-wide published constants (docs/prd/PRD-0003-dashboard/api.md
// "Named constants") — the one place every dashboard issue imports these
// from, so a future change is a single edit. ISS-0028/ISS-0029 import
// LATEST_SESSIONS_LIMIT/OVERVIEW_WINDOW_DAYS/READ_BUSY_TIMEOUT_MS from here;
// this issue is the only one that reads DASHBOARD_DEFAULT_PORT and the
// loopback allowlist.
//
// READ_BUSY_TIMEOUT_MS is re-exported from src/resolve-session.ts, which in
// turn imports it from src/core/ledger.ts's BUSY_TIMEOUT_MS — one literal,
// consumed by all three PRAGMA busy_timeout call sites (F1, PRD-0003
// integration review: the value used to be duplicated three ways).
import { READ_BUSY_TIMEOUT_MS } from "../resolve-session.js";

export { READ_BUSY_TIMEOUT_MS };
export const DASHBOARD_DEFAULT_PORT = 2278;
export const LATEST_SESSIONS_LIMIT = 50;
export const OVERVIEW_WINDOW_DAYS = 7;

// The Host-header allowlist (api.md Surface A, "the loopback wall") — a
// second, independent layer against a DNS rebind to a name that resolves to
// loopback, on top of the loopback-only socket bind. Any `:port` suffix is
// allowed; a bracketed IPv6 literal keeps its brackets so a naive colon-split
// never mistakes the address's own colons for the port separator.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostPart(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]");
    return closeIdx === -1 ? trimmed : trimmed.slice(0, closeIdx + 1);
  }
  const colonIdx = trimmed.lastIndexOf(":");
  return colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
}

// An absent/empty Host header is rejected too (api.md: "or Host is
// absent/empty") — never treated as trusted by default.
export function isLoopbackHostHeader(hostHeader: string | undefined | null): boolean {
  if (!hostHeader || hostHeader.trim().length === 0) return false;
  return LOOPBACK_HOSTNAMES.has(hostPart(hostHeader));
}

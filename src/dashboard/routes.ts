// The dashboard's /api/* route registry (docs/issues/ISS-0027.md) — the
// shared surface ISS-0028 (the overview handler) and ISS-0029 (the
// session-view handler) each amend, replacing one stub entry's handler in
// place, mirroring src/cli/index.ts's COMMANDS table. Ships here with valid
// empty-shaped stub handlers so the server is green and the GET wall is
// testable before either endpoint lands.

import { overviewHandler } from "./overview.js";
import { sessionHandler } from "./session.js";

export interface DashboardRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export type ApiHandler = (
  req: DashboardRequest,
  params: Record<string, string>,
) => ApiResult | Promise<ApiResult>;

interface ApiRoute {
  pattern: RegExp;
  paramNames: string[];
  handler: ApiHandler;
}

const API_ROUTES: ApiRoute[] = [
  { pattern: /^\/api\/overview\/?$/, paramNames: [], handler: overviewHandler },
  { pattern: /^\/api\/session\/([^/]+)\/?$/, paramNames: ["id"], handler: sessionHandler },
];

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function matchApiRoute(
  pathname: string,
): { handler: ApiHandler; params: Record<string, string> } | null {
  for (const route of API_ROUTES) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1] ?? "");
    });
    return { handler: route.handler, params };
  }
  return null;
}

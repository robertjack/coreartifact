// The node:http server core (docs/issues/ISS-0027.md "Contract") — binds
// loopback only, selects a port (explicit > DASHBOARD_DEFAULT_PORT >
// ephemeral fallback), and enforces the strictly read-only GET wall (api.md
// Surface A) before any route resolves. Exposes exactly
// `startDashboardServer`, resolving to `{ url, close() }`.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:http import below is `@ts-ignore`d at
// the import site and re-typed through local interfaces describing only the
// surface this file calls, same pattern as src/check/run.ts.

// @ts-ignore -- node:http has no ambient types available in this sandbox
import { createServer as createServerFn } from "node:http";
import { DASHBOARD_DEFAULT_PORT, isLoopbackHostHeader } from "./constants.js";
import { matchApiRoute, isApiPath, type DashboardRequest } from "./routes.js";
import { resolveRequestPath, contentTypeFor, readShell, readAsset } from "./assets.js";

interface IncomingMessageLike extends DashboardRequest {}

interface ServerResponseLike {
  writeHead(statusCode: number, headers?: Record<string, string>): void;
  end(chunk?: string | Uint8Array): void;
}

interface NodeErrorLike extends Error {
  code?: string;
}

interface AddressInfoLike {
  port: number;
}

type RequestListener = (req: IncomingMessageLike, res: ServerResponseLike) => void;

interface HttpServerLike {
  listen(port: number, host: string): void;
  once(event: "listening" | "error", listener: (err?: NodeErrorLike) => void): void;
  removeListener(event: "listening" | "error", listener: (err?: NodeErrorLike) => void): void;
  close(callback?: (err?: Error) => void): void;
  closeAllConnections(): void;
  address(): AddressInfoLike | string | null;
}

const createServer = createServerFn as (listener: RequestListener) => HttpServerLike;

// Loopback bind: never `0.0.0.0` (the contract's "binds loopback only").
const LOOPBACK_BIND_HOST = "127.0.0.1";

function jsonError(res: ServerResponseLike, status: number, code: string, message: string): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (status === 405) headers.Allow = "GET, HEAD";
  res.writeHead(status, headers);
  res.end(JSON.stringify({ error: { code, message } }));
}

function pathnameOf(url: string | undefined): string {
  if (!url) return "/";
  const withoutQuery = url.split("?")[0];
  return withoutQuery && withoutQuery.length > 0 ? withoutQuery : "/";
}

// The GET wall, in the order api.md Surface A mandates: method, then Host
// (the DNS-rebinding wall), then path traversal (folded into
// resolveRequestPath below), then routing — so nothing attacker-controlled
// is ever reflected or served before every earlier check has passed.
async function handleRequest(req: IncomingMessageLike, res: ServerResponseLike): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    jsonError(res, 405, "method_not_allowed", `method not allowed: ${method}`);
    return;
  }

  const hostHeader = req.headers.host;
  const hostValue = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!isLoopbackHostHeader(hostValue)) {
    jsonError(res, 403, "forbidden_host", "the request's Host header is not a loopback address");
    return;
  }

  const pathname = pathnameOf(req.url);
  const isHead = method === "HEAD";

  if (isApiPath(pathname)) {
    const route = matchApiRoute(pathname);
    if (!route) {
      jsonError(res, 404, "not_found", pathname);
      return;
    }
    const result = await route.handler(req, route.params);
    res.writeHead(result.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(isHead ? undefined : JSON.stringify(result.body));
    return;
  }

  const resolved = resolveRequestPath(pathname);
  if (resolved.kind === "outside-root") {
    jsonError(res, 404, "not_found", pathname);
    return;
  }
  if (resolved.kind === "file") {
    res.writeHead(200, {
      "Content-Type": contentTypeFor(resolved.filePath),
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.end(isHead ? undefined : readAsset(resolved.filePath));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(isHead ? undefined : readShell());
}

function listenOnce(server: HttpServerLike, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (err?: NodeErrorLike) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export interface DashboardServerOptions {
  port?: number;
}

export interface DashboardServerHandle {
  url: string;
  close(): Promise<void>;
}

// Port selection (the contract's "Port selection"): an explicit port
// (including 0, the acceptance lane's OS-assigned ephemeral) is always used
// as given. Without one, DASHBOARD_DEFAULT_PORT is tried first; only an
// EADDRINUSE on THAT attempt falls back to an ephemeral port — any other
// listen error propagates. The printed URL is always derived from the
// actually-bound address (`server.address()`), never the requested port.
export async function startDashboardServer(
  options: DashboardServerOptions = {},
): Promise<DashboardServerHandle> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      try {
        jsonError(res, 500, "internal_error", "unexpected server error");
      } catch {
        // The response may already be partially sent; nothing more to do.
      }
    });
  });

  if (options.port !== undefined) {
    await listenOnce(server, options.port, LOOPBACK_BIND_HOST);
  } else {
    try {
      await listenOnce(server, DASHBOARD_DEFAULT_PORT, LOOPBACK_BIND_HOST);
    } catch (err) {
      if ((err as NodeErrorLike)?.code !== "EADDRINUSE") throw err;
      await listenOnce(server, 0, LOOPBACK_BIND_HOST);
    }
  }

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : DASHBOARD_DEFAULT_PORT;
  const url = `http://${LOOPBACK_BIND_HOST}:${boundPort}/`;

  function close(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolvePromise();
      });
      // A keep-alive client socket left idle-open would otherwise make
      // `close()`'s callback wait indefinitely (Node only fires it once
      // every connection has ended) — force any lingering sockets closed so
      // shutdown is prompt and the port is always released (the contract's
      // "no lingering handles").
      server.closeAllConnections();
    });
  }

  return { url, close };
}

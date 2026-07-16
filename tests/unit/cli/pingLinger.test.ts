// Integration-level coverage for the ISS-0023 S2 fix ("the fire-and-forget
// ping is awaited on the CLI critical path"). Uses a REAL TCP black-hole
// listener (accepts the connection, never responds) and the REAL production
// transport (src/ping/transport.ts's createFetchTransport, unmodified,
// still bounded by its own 2000ms AbortController) and the REAL sender
// (src/ping/sender.ts's maybeSendPing) — nothing here is a stand-in for
// production ping-attempt code.
//
// The CLI seam itself (src/cli/index.ts's `main`) is untestable in-process:
// it always ends in `process.exit`, which would kill the test worker. So
// this file exercises the exact same wiring `main` now performs —
// start-before-handler, then race the in-flight ping against
// awaitPingWithGrace — using the same exported production pieces `main`
// calls (maybeSendPing, createFetchTransport, awaitPingWithGrace,
// PING_EXIT_GRACE_MS), against a real socket. PING_ENDPOINT itself is a
// pinned constant (docs/issues/ISS-0023.md) the CLI always passes to the
// transport unmodified; here the injected `transport` function (the same
// seam sender.ts's own unit tests use) is wrapped to redirect the outbound
// URL to the local black-hole/echo server instead, exactly as the
// acceptance suite's sink transport redirects delivery without touching
// PING_ENDPOINT itself.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendInstall, appendConsent } from "../../../src/core/operatorState.js";
import { maybeSendPing } from "../../../src/ping/sender.js";
import { createFetchTransport } from "../../../src/ping/transport.js";
import { awaitPingWithGrace, PING_EXIT_GRACE_MS } from "../../../src/ping/index.js";
import type { PingTransport } from "../../../src/ping/transport.js";

function primedStatePath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss0023-ping-linger-"));
  return path.join(tmpDir, "state.jsonl");
}

/** Wraps the real fetch transport so its outbound URL is redirected to a
 * local test server instead of the pinned PING_ENDPOINT host — the same
 * "injected transport" seam sender.ts's own tests use, applied to the real
 * transport implementation rather than a fake one. */
function realTransportAgainst(localUrl: string): PingTransport {
  const real = createFetchTransport();
  return (_url, payload) => real(localUrl, payload);
}

describe("ISS-0023 S2 fix: ping must not linger on the CLI critical path", () => {
  const servers: net.Server[] = [];
  const openSockets = new Set<net.Socket>();

  afterEach(async () => {
    // A black-hole listener never closes its own sockets, so they must be
    // destroyed directly before `server.close()` — otherwise `close()`
    // waits forever for a connection that is never going away.
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();

    const pending = servers.splice(0);
    await Promise.all(
      pending.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  function startBlackHole(): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        // Accept the TCP connection and never write, never close — a true
        // black hole. The only thing that ever ends this is the client's
        // own AbortController timeout (transport.ts's 2000ms bound), or
        // this test's own afterEach destroying the socket directly.
        openSockets.add(socket);
        socket.on("close", () => openSockets.delete(socket));
        socket.on("error", () => {
          // ignore ECONNRESET etc. once the client aborts
        });
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  }

  it(
    "RED proof (pre-fix shape): awaiting the ping AFTER the handler, against a stalled endpoint, " +
      "blocks for the full ~2000ms transport bound",
    async () => {
      const port = await startBlackHole();
      const statePath = primedStatePath();
      await appendInstall("11111111-1111-4111-8111-111111111111", statePath);
      await appendConsent(true, statePath);

      const transport = realTransportAgainst(`http://127.0.0.1:${port}/ping`);

      // This mirrors the OLD src/cli/index.ts shape exactly: the handler
      // finishes instantly, THEN the ping is awaited.
      const handlerDone = Date.now();
      await maybeSendPing({ statePath, version: "1.0.0", transport });
      const elapsed = Date.now() - handlerDone;

      // Proves the old await-after-handler shape really does hold the
      // process open for ~2000ms against a stalled endpoint.
      expect(elapsed).toBeGreaterThan(1800);
      expect(elapsed).toBeLessThan(2600);
    },
    5000,
  );

  it(
    "GREEN proof (fixed shape): starting the ping BEFORE the handler and racing it against " +
      "PING_EXIT_GRACE_MS after the handler completes adds at most the grace, never the full bound",
    async () => {
      const port = await startBlackHole();
      const statePath = primedStatePath();
      await appendInstall("22222222-2222-4222-8222-222222222222", statePath);
      await appendConsent(true, statePath);

      const transport = realTransportAgainst(`http://127.0.0.1:${port}/ping`);

      // Mirrors the FIXED src/cli/index.ts shape: start the ping before
      // dispatching the handler, run the handler, then race.
      const pingPromise = maybeSendPing({ statePath, version: "1.0.0", transport }).catch(() => {});

      // Simulate the command handler doing a small amount of real work —
      // short compared to the transport's 2000ms bound, proving the
      // overlap doesn't require the handler to be slow to pay off.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const handlerDone = Date.now();
      await awaitPingWithGrace(pingPromise, PING_EXIT_GRACE_MS);
      const elapsed = Date.now() - handlerDone;

      // Generous CI margin, but sharply discriminating against the ~2000ms
      // figure proved above.
      expect(elapsed).toBeLessThan(600);
    },
    5000,
  );

  it(
    "delivery is preserved on a healthy endpoint: a ping started before a handler that outlives " +
      "the round trip still arrives",
    async () => {
      let received: unknown;
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          received = JSON.parse(body);
          res.writeHead(200);
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      servers.push(server as unknown as net.Server);

      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      const statePath = primedStatePath();
      await appendInstall("33333333-3333-4333-8333-333333333333", statePath);
      await appendConsent(true, statePath);

      const transport = realTransportAgainst(`http://127.0.0.1:${port}/ping`);

      // Start before the "handler" (mirrors the fixed CLI shape), and let
      // the handler run longer than the local round trip so the overlap is
      // real, not accidental.
      const pingPromise = maybeSendPing({ statePath, version: "2.0.0", transport }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 60));

      await awaitPingWithGrace(pingPromise, PING_EXIT_GRACE_MS);
      // Give the server's own event loop a moment to finish processing the
      // already-flushed request body.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(received).toEqual({ version: "2.0.0", install_id: "33333333-3333-4333-8333-333333333333" });
    },
    5000,
  );
});

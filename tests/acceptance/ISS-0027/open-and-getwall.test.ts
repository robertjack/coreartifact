// ISS-0027 acceptance tests — `open` + the dashboard server core (the GET
// wall). Every criterion here drives the BUILT CLI as a real subprocess and
// asserts raw HTTP over loopback, per the issue packet's Test-harness
// contract: the server cannot be red-tested without the command, and the
// command does nothing without the server.
//
// `open` starts a long-lived server rather than exiting like every other
// command, so this file adds its own spawn/URL-wait/HTTP helpers alongside
// the shared harness (createTmpRepo, runCli for `init`, baseHermeticEnv) —
// it imports the harness for everything it already covers and never forks
// it. The CLI is invoked directly (`node dist/cli/bin.js open ...` or, for
// the cart/coreartifact parity test, the installed bins from a real `pnpm
// pack`+`pnpm add`, mirroring ISS-0009's packaging test) — never by
// importing server.ts/routes.ts/assets.ts internals, since the public HTTP
// surface is the only thing this issue's contract commits to.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import http, { type IncomingHttpHeaders } from "node:http";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpRepo, runCli, baseHermeticEnv, type TmpRepo } from "../harness/index.js";

// tests/acceptance/ISS-0027/open-and-getwall.test.ts -> repo root is three levels up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "bin.js");
const DIST_WEB = join(REPO_ROOT, "dist", "web");
const DEFAULT_PORT = 2278;

function assertBuilt(): void {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI build not found at ${CLI_ENTRY}. The harness's globalSetup (tests/acceptance/harness/globalSetup.ts) ` +
        "is supposed to build it once before any test runs.",
    );
  }
}

interface HermeticEnvOptions {
  home: string;
  registryPath: string;
  extraPath?: string;
}

function envFor(options: HermeticEnvOptions): NodeJS.ProcessEnv {
  const base = baseHermeticEnv(options.home);
  const env: NodeJS.ProcessEnv = {
    ...base,
    COREARTIFACT_REGISTRY_ROOT: dirname(options.registryPath),
  };
  if (options.extraPath) {
    env.PATH = `${options.extraPath}:${base.PATH ?? ""}`;
  }
  return env;
}

interface SpawnedOpen {
  child: ChildProcess;
  url: string;
  port: number;
  stdout(): string;
  stderr(): string;
}

function spawnCliAndWaitForUrl(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<SpawnedOpen> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`open did not print a URL within ${timeoutMs}ms; stdout: ${stdout}; stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (settled) return;
      const match = stdout.match(/https?:\/\/\S+/);
      if (match) {
        settled = true;
        clearTimeout(timer);
        const url = match[0].replace(/[).,;'"]+$/, "");
        const port = Number(new URL(url).port);
        resolvePromise({ child, url, port, stdout: () => stdout, stderr: () => stderr });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`open exited (code ${code}) before printing a URL; stdout: ${stdout}; stderr: ${stderr}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise) => {
    child.on("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; path?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: options.path ?? target.pathname,
        method: options.method ?? "GET",
        headers: options.headers,
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`request to ${url} timed out`));
    });
    req.end();
  });
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createNetServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => {
      server.close(() => resolvePromise(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function occupyPort(port: number): Promise<{ close(): Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.once("listening", () => {
      resolvePromise({ close: () => new Promise((res) => server.close(() => res())) });
    });
    server.listen(port, "127.0.0.1");
  });
}

describe("ISS-0027 open command + dashboard server core (the GET wall)", () => {
  const tmpRepos: TmpRepo[] = [];
  const liveChildren: ChildProcess[] = [];

  afterAll(async () => {
    for (const child of liveChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    "From any cwd, with at least one registered repo present, coreartifact open --port 0 --no-browser starts a server, prints the bound URL on stdout, and a GET of that URL returns 200 with Content-Type text/html and the dashboard shell body.",
    async () => {
      assertBuilt();
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(initResult.exitCode, `init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

      const outsideCwd = mkdtempSync(join(tmpdir(), "coreartifact-open-cwd-"));
      const env = envFor({ home: repo.home, registryPath: repo.registryPath });
      const opened = await spawnCliAndWaitForUrl(
        process.execPath,
        [CLI_ENTRY, "open", "--port", "0", "--no-browser"],
        outsideCwd,
        env,
      );
      liveChildren.push(opened.child);

      const res = await httpRequest(opened.url);
      expect(res.status, "GET of the printed URL did not return 200").toBe(200);
      expect(res.headers["content-type"], "shell response Content-Type was not text/html").toMatch(/text\/html/);

      const shellPath = join(DIST_WEB, "index.html");
      if (!existsSync(shellPath)) {
        throw new Error(`expected the built shell at ${shellPath}; ISS-0026's build must have run first`);
      }
      const expectedShell = readFileSync(shellPath, "utf8");
      expect(res.body, "shell response body did not match the built dist/web/index.html shell").toBe(expectedShell);

      opened.child.kill("SIGTERM");
      await waitForExit(opened.child);
    },
    30_000,
  );

  it(
    "The server binds a loopback address only; the printed URL host resolves to loopback and the server is not reachable on any non-loopback interface.",
    async () => {
      assertBuilt();
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });

      const env = envFor({ home: repo.home, registryPath: repo.registryPath });
      const opened = await spawnCliAndWaitForUrl(
        process.execPath,
        [CLI_ENTRY, "open", "--port", "0", "--no-browser"],
        repo.root,
        env,
      );
      liveChildren.push(opened.child);

      const host = new URL(opened.url).hostname;
      const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
      expect(loopbackHosts.has(host), `printed URL host "${host}" is not a loopback literal`).toBe(true);

      const nets = networkInterfaces();
      const nonLoopbackIPv4: string[] = [];
      for (const ifaceList of Object.values(nets)) {
        for (const iface of ifaceList ?? []) {
          if (iface.family === "IPv4" && !iface.internal) nonLoopbackIPv4.push(iface.address);
        }
      }
      if (nonLoopbackIPv4.length > 0) {
        await expect(httpRequest(`http://${nonLoopbackIPv4[0]}:${opened.port}/`)).rejects.toBeTruthy();
      }

      opened.child.kill("SIGTERM");
      await waitForExit(opened.child);
    },
    30_000,
  );

  it(
    "Run without --port, coreartifact open --no-browser attempts the default port 2278 first and prints a URL whose port is 2278 when it is free; when 2278 is already bound the server binds an ephemeral port instead and the printed URL carries that port, and in both cases the printed URL is the authoritative one a GET succeeds against.",
    async (ctx) => {
      assertBuilt();
      const free = await canBind(DEFAULT_PORT);
      if (!free) {
        // Retro addendum (docs/prd/PRD-0003-dashboard/retro.md, post-retro
        // addendum): a real dashboard the operator is dogfooding (or any
        // other process) can legitimately hold 2278 — that is not a defect,
        // and this test must never turn that ordinary state of the machine
        // into a false red. Skip with the collision named, rather than
        // failing or silently passing; when 2278 is free this test runs
        // exactly as it always has.
        ctx.skip(
          `port ${DEFAULT_PORT} is already bound on this machine (e.g. a live \`coreartifact open\` dashboard) — skipping the default-port criterion rather than false-redding the suite`,
        );
        return;
      }

      // Free case.
      const repoA = await createTmpRepo();
      tmpRepos.push(repoA);
      await runCli(["init"], { cwd: repoA.root, home: repoA.home, registryPath: repoA.registryPath });
      const envA = envFor({ home: repoA.home, registryPath: repoA.registryPath });
      const openedFree = await spawnCliAndWaitForUrl(process.execPath, [CLI_ENTRY, "open", "--no-browser"], repoA.root, envA);
      liveChildren.push(openedFree.child);
      expect(openedFree.port, "open did not bind the default port 2278 when it was free").toBe(DEFAULT_PORT);
      const resFree = await httpRequest(openedFree.url);
      expect(resFree.status, "GET of the printed URL (default-port case) did not succeed").toBe(200);
      openedFree.child.kill("SIGTERM");
      await waitForExit(openedFree.child);

      // Busy case: bind 2278 ourselves first.
      const blocker = await occupyPort(DEFAULT_PORT);
      try {
        const repoB = await createTmpRepo();
        tmpRepos.push(repoB);
        await runCli(["init"], { cwd: repoB.root, home: repoB.home, registryPath: repoB.registryPath });
        const envB = envFor({ home: repoB.home, registryPath: repoB.registryPath });
        const openedBusy = await spawnCliAndWaitForUrl(
          process.execPath,
          [CLI_ENTRY, "open", "--no-browser"],
          repoB.root,
          envB,
        );
        liveChildren.push(openedBusy.child);
        expect(
          openedBusy.port,
          "open bound the default port 2278 even though it was already occupied",
        ).not.toBe(DEFAULT_PORT);
        const resBusy = await httpRequest(openedBusy.url);
        expect(resBusy.status, "GET of the printed URL (fallback case) did not succeed").toBe(200);
        openedBusy.child.kill("SIGTERM");
        await waitForExit(openedBusy.child);
      } finally {
        await blocker.close();
      }
    },
    30_000,
  );

  it(
    "Sending SIGINT to the running open process shuts the server down and the process exits without leaving the port bound; sending SIGTERM does the same.",
    async () => {
      assertBuilt();

      async function checkSignal(signal: NodeJS.Signals): Promise<void> {
        const repo = await createTmpRepo();
        tmpRepos.push(repo);
        await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
        const env = envFor({ home: repo.home, registryPath: repo.registryPath });
        const opened = await spawnCliAndWaitForUrl(
          process.execPath,
          [CLI_ENTRY, "open", "--port", "0", "--no-browser"],
          repo.root,
          env,
        );
        liveChildren.push(opened.child);

        const preSignal = await httpRequest(opened.url);
        expect(preSignal.status, "server was not serving before the signal was sent").toBe(200);

        opened.child.kill(signal);
        const { code, signal: exitSignal } = await waitForExit(opened.child);
        expect(
          code === 0 || exitSignal === signal,
          `process did not exit cleanly after ${signal} (code=${code}, signal=${exitSignal})`,
        ).toBe(true);

        const rebindable = await canBind(opened.port);
        expect(rebindable, `port ${opened.port} was still bound after ${signal} shut the server down`).toBe(true);
      }

      await checkSignal("SIGINT");
      await checkSignal("SIGTERM");
    },
    30_000,
  );

  it(
    "cart open --port 0 --no-browser behaves identically to coreartifact open --port 0 --no-browser.",
    async () => {
      assertBuilt();
      const packOutDir = mkdtempSync(join(tmpdir(), "coreartifact-open-pack-"));
      const installDir = mkdtempSync(join(tmpdir(), "coreartifact-open-install-"));

      try {
        const packResult = spawnSync("pnpm", ["pack", "--pack-destination", packOutDir], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        });
        expect(packResult.status, `pnpm pack failed: ${packResult.stderr}`).toBe(0);
        const tgzName = readdirSync(packOutDir).find((name) => name.endsWith(".tgz"));
        if (!tgzName) throw new Error(`pnpm pack produced no .tgz in ${packOutDir}`);
        const tgzPath = join(packOutDir, tgzName);

        writeFileSync(
          join(installDir, "package.json"),
          JSON.stringify({ name: "coreartifact-open-install-target", version: "0.0.0", private: true }, null, 2),
        );
        const addResult = spawnSync("pnpm", ["add", tgzPath], { cwd: installDir, encoding: "utf8" });
        expect(addResult.status, `pnpm add of the packed tarball failed: ${addResult.stderr}`).toBe(0);

        const coreartifactBin = join(installDir, "node_modules", ".bin", "coreartifact");
        const cartBin = join(installDir, "node_modules", ".bin", "cart");
        expect(existsSync(coreartifactBin), "installed package did not expose a coreartifact bin").toBe(true);
        expect(existsSync(cartBin), "installed package did not expose a cart bin").toBe(true);

        const repo = await createTmpRepo();
        tmpRepos.push(repo);
        await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
        const env = envFor({ home: repo.home, registryPath: repo.registryPath });

        const openedA = await spawnCliAndWaitForUrl(
          coreartifactBin,
          ["open", "--port", "0", "--no-browser"],
          repo.root,
          env,
        );
        liveChildren.push(openedA.child);
        const resA = await httpRequest(openedA.url);
        openedA.child.kill("SIGTERM");
        await waitForExit(openedA.child);

        const openedB = await spawnCliAndWaitForUrl(cartBin, ["open", "--port", "0", "--no-browser"], repo.root, env);
        liveChildren.push(openedB.child);
        const resB = await httpRequest(openedB.url);
        openedB.child.kill("SIGTERM");
        await waitForExit(openedB.child);

        expect(resB.status, "cart open's response status differed from coreartifact open's").toBe(resA.status);
        expect(
          resB.headers["content-type"],
          "cart open's Content-Type differed from coreartifact open's",
        ).toBe(resA.headers["content-type"]);
        expect(resB.body, "cart open's response body differed from coreartifact open's").toBe(resA.body);
      } finally {
        rmSync(packOutDir, { recursive: true, force: true });
        rmSync(installDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "With --no-browser passed, no browser is launched even when stdout is a TTY; browser auto-open is attempted only when stdout is a TTY and --no-browser is absent.",
    async () => {
      // The subprocess seam here never gives the child a real TTY on stdout
      // (no PTY available, same limit ISS-0022's uninstall TTY test names) —
      // this asserts the always-testable half: passing --no-browser
      // suppresses the platform opener regardless of stdout's TTY-ness.
      assertBuilt();
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });

      const stubDir = mkdtempSync(join(tmpdir(), "coreartifact-open-stub-bin-"));
      const markerPath = join(stubDir, "opened.marker");
      for (const opener of ["open", "xdg-open"]) {
        const stubPath = join(stubDir, opener);
        writeFileSync(stubPath, `#!/bin/sh\necho "$@" >> "${markerPath}"\nexit 0\n`);
        chmodSync(stubPath, 0o755);
      }

      const env = envFor({ home: repo.home, registryPath: repo.registryPath, extraPath: stubDir });
      const opened = await spawnCliAndWaitForUrl(
        process.execPath,
        [CLI_ENTRY, "open", "--port", "0", "--no-browser"],
        repo.root,
        env,
      );
      liveChildren.push(opened.child);

      await httpRequest(opened.url);
      expect(existsSync(markerPath), "a browser opener was invoked even though --no-browser was passed").toBe(false);

      opened.child.kill("SIGTERM");
      await waitForExit(opened.child);
    },
    30_000,
  );

  describe("the GET wall", () => {
    // beforeAll swallows its own setup failure into `setupError` rather than
    // throwing (S1b-style, ISS-0026's scaffold-build.test.ts precedent): a
    // thrown beforeAll marks every nested `it` as "skipped", not "failed",
    // which would hide these five criteria's red state instead of showing
    // it. Each test below asserts on `setupError` first so a missing `open`
    // command surfaces as this test's own failing assertion.
    let repo: TmpRepo | undefined;
    let opened: SpawnedOpen | undefined;
    let setupError: unknown;

    beforeAll(async () => {
      try {
        assertBuilt();
        repo = await createTmpRepo();
        const initResult = await runCli(["init"], {
          cwd: repo.root,
          home: repo.home,
          registryPath: repo.registryPath,
        });
        if (initResult.exitCode !== 0) {
          throw new Error(`init did not exit 0 in GET-wall setup; stderr: ${initResult.stderr}`);
        }
        const env = envFor({ home: repo.home, registryPath: repo.registryPath });
        opened = await spawnCliAndWaitForUrl(
          process.execPath,
          [CLI_ENTRY, "open", "--port", "0", "--no-browser"],
          repo.root,
          env,
        );
      } catch (err) {
        setupError = err;
      }
    }, 30_000);

    afterAll(async () => {
      if (opened) {
        opened.child.kill("SIGTERM");
        await waitForExit(opened.child);
      }
      if (repo) await repo.cleanup();
    });

    function requireOpened(): SpawnedOpen {
      if (!opened) {
        throw new Error(`GET-wall setup (spawning open) failed: ${String(setupError)}`);
      }
      return opened;
    }

    it("A request with a method other than GET or HEAD returns 405 with an Allow header listing GET, HEAD and a JSON error body whose code is method_not_allowed.", async () => {
      const opened = requireOpened();
      const res = await httpRequest(opened.url, { method: "POST" });
      expect(res.status, "non-GET/HEAD request did not return 405").toBe(405);
      expect(res.headers["allow"], "405 response had no Allow header").toBeDefined();
      const allow = String(res.headers["allow"]);
      expect(allow, "Allow header did not list GET").toMatch(/GET/);
      expect(allow, "Allow header did not list HEAD").toMatch(/HEAD/);
      const parsed = JSON.parse(res.body);
      expect(parsed.error?.code, "405 JSON error body code was not method_not_allowed").toBe("method_not_allowed");
    });

    it("A request whose path attempts traversal above the asset root (for example a path containing /../) never returns content from outside dist/web/ and returns 404 with a JSON error body whose code is not_found.", async () => {
      const opened = requireOpened();
      const res = await httpRequest(opened.url, { path: "/../../../../../../etc/passwd" });
      expect(res.status, "path traversal request did not return 404").toBe(404);
      const parsed = JSON.parse(res.body);
      expect(parsed.error?.code, "404 JSON error body code was not not_found").toBe("not_found");
      expect(res.body, "traversal response body appears to contain /etc/passwd content").not.toMatch(/root:.*:0:0:/);
    });

    it("A request whose Host header host-part is not localhost, 127.0.0.1, or [::1] returns 403 with a JSON error body whose code is forbidden_host and reflects no attacker-controlled host value.", async () => {
      const opened = requireOpened();
      const attackerHost = "evil-host.invalid";
      const res = await httpRequest(opened.url, { headers: { Host: attackerHost } });
      expect(res.status, "non-loopback Host header did not return 403").toBe(403);
      const parsed = JSON.parse(res.body);
      expect(parsed.error?.code, "403 JSON error body code was not forbidden_host").toBe("forbidden_host");
      expect(res.body, "403 response body reflected the attacker-controlled Host value").not.toContain(attackerHost);
    });

    it("Every /api/* response and the shell response carry Cache-Control: no-store.", async () => {
      const opened = requireOpened();
      const overviewRes = await httpRequest(opened.url, { path: "/api/overview" });
      expect(
        overviewRes.headers["cache-control"],
        "/api/overview response did not carry Cache-Control: no-store",
      ).toBe("no-store");

      const sessionRes = await httpRequest(opened.url, { path: "/api/session/test-session-id" });
      expect(
        sessionRes.headers["cache-control"],
        "/api/session/<id> response did not carry Cache-Control: no-store",
      ).toBe("no-store");

      const shellRes = await httpRequest(opened.url, { path: "/" });
      expect(shellRes.headers["cache-control"], "shell response did not carry Cache-Control: no-store").toBe(
        "no-store",
      );
    });

    it("A GET of a non-/api path that does not resolve to a real asset file returns the shell with 200 (SPA client-routing fallback), while a GET of a content-hashed asset under /assets/ returns that asset with 200.", async () => {
      const opened = requireOpened();
      const fallbackRes = await httpRequest(opened.url, { path: "/some/client-routed/path" });
      expect(fallbackRes.status, "unresolved non-/api path did not fall back to the shell with 200").toBe(200);
      expect(
        fallbackRes.headers["content-type"],
        "SPA fallback response Content-Type was not text/html",
      ).toMatch(/text\/html/);

      const assetsDir = join(DIST_WEB, "assets");
      if (!existsSync(assetsDir)) {
        throw new Error(`expected built assets at ${assetsDir}; ISS-0026's build must have run first`);
      }
      const assetFile = readdirSync(assetsDir).find((name) => /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/i.test(name));
      if (!assetFile) throw new Error(`no content-hashed asset file found under ${assetsDir}`);

      const assetRes = await httpRequest(opened.url, { path: `/assets/${assetFile}` });
      expect(assetRes.status, `GET of /assets/${assetFile} did not return 200`).toBe(200);
    });
  });
});

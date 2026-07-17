// `coreartifact open` — starts the dashboard's HTTP server and prints the
// bound URL (docs/issues/ISS-0027.md). Unlike every other command this one
// is long-lived: it never resolves to an exit code on its own. It installs
// SIGINT/SIGTERM handlers that tear the server down and exit the process
// directly, releasing the port (the contract's "Lifecycle"). `open.ts`
// never guards an entry point (docs/gotchas.md #1) — `src/cli/bin.ts` stays
// the sole entry point; this is a long-lived command handler, not an
// import-vs-execute question.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:child_process import below is
// `@ts-ignore`d at the import site and re-typed through a local interface,
// same pattern as src/check/run.ts / src/install/gitRepo.ts.

// @ts-ignore -- node:child_process has no ambient types available in this sandbox
import { spawn as spawnFn } from "node:child_process";
import { startDashboardServer } from "../../dashboard/server.js";
import { scrubbedEnv } from "../../core/attribution.js";

interface SpawnOptions {
  env: Record<string, string | undefined>;
  stdio: "ignore";
  detached?: boolean;
}
interface ChildProcessLike {
  unref(): void;
  on(event: "error", listener: (err: unknown) => void): void;
}
const spawn = spawnFn as (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;

declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
  stdout: { write(chunk: string): boolean; isTTY?: boolean };
  stderr: { write(chunk: string): boolean };
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  exit(code?: number): never;
};

interface ParsedOpenArgs {
  port?: number;
  noBrowser: boolean;
}

const USAGE = "coreartifact open: usage: coreartifact open [--port <n>] [--no-browser]";

// Strict parsing, same discipline as src/check/argv.ts: an unrecognized
// token or a malformed --port value is a usage error, never silently
// dropped or ignored.
function parseOpenArgv(args: string[]): { ok: true; value: ParsedOpenArgs } | { ok: false; message: string } {
  let port: number | undefined;
  let noBrowser = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port") {
      const raw = args[i + 1];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (raw === undefined || !Number.isInteger(parsed) || parsed < 0) {
        return { ok: false, message: USAGE };
      }
      port = parsed;
      i++;
      continue;
    }
    if (arg === "--no-browser") {
      noBrowser = true;
      continue;
    }
    return { ok: false, message: USAGE };
  }

  return { ok: true, value: { port, noBrowser } };
}

// Best-effort platform opener, allowlist-scrubbed env (gotcha #3 — never
// `{ ...process.env }`; reuse src/core/attribution.ts's scrubbedEnv rather
// than reinventing the allowlist). A missing/failing opener never fails
// `open` itself — the server is already up and the URL already printed.
function openBrowser(url: string): void {
  const env = scrubbedEnv(process.env);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { env, stdio: "ignore", detached: true });
    child.on("error", () => {
      // Swallowed: a missing platform opener is not this command's failure.
    });
    child.unref();
  } catch {
    // Swallowed, same rationale.
  }
}

export async function openCommand(args: string[]): Promise<number> {
  const parsed = parseOpenArgv(args);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    return 1;
  }

  const handle = await startDashboardServer({ port: parsed.value.port });
  process.stdout.write(`${handle.url}\n`);

  // Browser auto-open only when stdout is a TTY and --no-browser is absent
  // (the contract's exact condition).
  if (!parsed.value.noBrowser && process.stdout.isTTY) {
    openBrowser(handle.url);
  }

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    handle.close().finally(() => process.exit(0));
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Never resolves on its own: this command stays alive, serving requests,
  // until a signal tears the server down via `shutdown` above.
  return new Promise<number>(() => {});
}

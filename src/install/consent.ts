// The one-time consent question `init` asks at first-init-on-the-machine
// (docs/issues/ISS-0023.md "Consent at init (R10)"). Isolated from
// src/cli/commands/init.ts so the TTY/answer seam is unit-testable without
// spawning a subprocess: askConsent takes an injected ConsentIO, and only
// realConsentIO() (the production implementation) touches process.stdin.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:readline import below is
// `@ts-ignore`d at the import site and re-typed through a local interface.

// @ts-ignore -- node:readline has no ambient types available in this sandbox
import { createInterface as createInterfaceFn } from "node:readline";

interface ReadlineInterface {
  question(prompt: string, callback: (answer: string) => void): void;
  close(): void;
}
const createInterface = createInterfaceFn as (options: { input: unknown; output: unknown }) => ReadlineInterface;

declare const process: {
  stdin: { isTTY?: boolean };
  stdout: unknown;
};

// Names exactly what the ping sends (packet: "naming exactly what the ping
// sends (anonymous weekly ping, version + install id)"). Default is no: an
// empty answer (bare Enter) or anything but an explicit yes must record no.
export const CONSENT_QUESTION =
  "Send an anonymous weekly ping to coreartifact.com (version + install id only)? [y/N] ";

export function isYesAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

export interface ConsentIO {
  isTTY: boolean;
  ask(prompt: string): Promise<string>;
}

// stdin is a TTY -> ask, default no on anything but an explicit yes.
// No TTY -> record no without prompting and without hanging (packet: "the
// fleet lane never blocks"); `ask` is never called in that branch, so a
// piped, never-closed stdin cannot wedge this.
export async function askConsent(io: ConsentIO): Promise<boolean> {
  if (!io.isTTY) return false;
  const answer = await io.ask(CONSENT_QUESTION);
  return isYesAnswer(answer);
}

// Production ConsentIO: real stdin/stdout via node:readline. isTTY reads
// process.stdin.isTTY directly (undefined on a plain pipe, exactly the
// non-interactive/fleet-lane case) rather than any heuristic.
export function realConsentIO(): ConsentIO {
  return {
    isTTY: process.stdin.isTTY === true,
    ask: (prompt) =>
      new Promise((resolvePromise) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (answer: string) => {
          rl.close();
          resolvePromise(answer);
        });
      }),
  };
}

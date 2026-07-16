// ISS-0015 test helpers — mirrors tests/acceptance/ISS-0010/helpers.ts exactly
// (tryImport pattern) plus a small writer-name resolver: the packet names
// `readState`'s return shape explicitly but never names the write-side
// export(s), so tests resolve whichever reasonably-named writer the
// implementation actually exports rather than hard-guessing one symbol and
// permanently failing a correct-but-differently-named implementation.

export async function tryImport(modulePath: string): Promise<any> {
  try {
    return await import(modulePath);
  } catch {
    return undefined;
  }
}

export const STATE_MODULE_PATH = "../../../src/core/state.js";
export const PATHS_MODULE_PATH = "../../../src/core/paths.js";

// Candidate names for the per-op writers described in the packet's
// "Writers" list (install / consent / ping), in descending order of how
// closely they mirror registry.ts's `addLedger` naming convention.
export const INSTALL_WRITER_NAMES = ["appendInstall", "recordInstall", "writeInstall", "logInstall"];
export const CONSENT_WRITER_NAMES = ["appendConsent", "recordConsent", "writeConsent", "setConsent"];
export const PING_WRITER_NAMES = ["appendPing", "recordPing", "writePing", "logPing"];

// Fallback candidates for a single generic writer shared across all three
// ops (the shape registry.ts itself uses: one write primitive), called as
// `writer(op, fields)`.
export const GENERIC_WRITER_NAMES = ["appendState", "appendStateEntry", "appendStateOp", "writeState"];

export interface ResolvedWriter {
  name: string;
  kind: "per-op" | "generic";
}

export function resolveWriter(
  mod: any,
  perOpCandidates: string[],
  op: "install" | "consent" | "ping"
): ResolvedWriter | undefined {
  for (const name of perOpCandidates) {
    if (typeof mod?.[name] === "function") return { name, kind: "per-op" };
  }
  for (const name of GENERIC_WRITER_NAMES) {
    if (typeof mod?.[name] === "function") return { name, kind: "generic" };
  }
  return undefined;
}

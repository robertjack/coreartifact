#!/usr/bin/env node
// The CLI process entry point. This file is only ever executed (it is what
// both `bin` entries in package.json point at, compiled), never imported —
// so "am I the entry point?" is a question nobody has to ask, and there is
// nothing here to guard.
//
// `src/cli/index.ts` is the pure module: it exports `main` and the command
// table and never invokes anything at module scope. This file's entire body
// is "import main, call it" — see index.ts's header for why an
// import.meta.url entrypoint guard was tried and rejected instead (V1,
// 2026-07-14): it broke through a symlink (node_modules/.bin's install
// layout) and through an `@`-containing path (pnpm's store layout),
// silently exiting 0 and printing nothing in both cases.
declare const process: {
  argv: string[];
  exit(code?: number): never;
  stderr: { write(chunk: string): boolean };
};

import { main } from "./index.js";

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`coreartifact: unexpected error\n${String(err)}\n`);
  process.exit(1);
});

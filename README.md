# coreartifact

A local-first evidence ledger for agent-built software. It captures what
your Claude Code sessions actually did — commands, files, checks, cost —
into an append-only spool on your machine, and turns it into a queryable
ledger and a local dashboard.

## The laws

These are not preferences. They are the product.

- **Nothing leaves your machine.** No code, no transcripts, no telemetry
  by default. The only network call in the product is an explicit opt-in
  ping, and it carries an install id — never your code.
- **The raw spool is ground truth forever.** The ledger is a pure
  projection: delete it and re-ingest, and you get the same answers. The
  spool is never rewritten.
- **Absence is honest.** When a fact can't be verified from captured
  evidence, it records as ABSENT with a reason — never fabricated, never
  silently zero, never guessed.
- **Capture never breaks the host.** The capture hook appends payloads
  verbatim, exits 0, and knows nothing about schemas or versions. Your
  Claude Code session cannot be broken by it.

> **Pre-1.0.** Interfaces may change without notice and there is no
> support commitment. Issues are welcome; see CONTRIBUTING.md.

## Quickstart

Requires Node >= 22.13.

```sh
npm install -g coreartifact
cd your-repo
coreartifact init     # registers the repo, installs the capture hook
# ... run a Claude Code session in the repo ...
coreartifact log      # session timeline
coreartifact show <session-id>   # one session in detail
```

`cart` is the blessed short alias — same binary, fewer keystrokes.

More verbs:

```sh
cart check test -- pnpm test   # run a command as recorded, bound evidence
cart open                      # local dashboard (default port 2278)
cart doctor                    # every currently-degrading facet, read-only
cart uninstall                 # removes coreartifact from the repo
```

`cart check` records the wrapped command's output and exit code as
evidence in the ledger and passes the exit code through unchanged — in a
delegated (agent) session, that is what turns "the agent says the tests
passed" into a bound, queryable fact.

## Tested Claude Code range

Facets are verified against Claude Code **2.1.208 – 2.1.216** (see the
dated findings in `docs/recording-pass.md`). Outside that range, capture
still records everything; derived facets may degrade to ABSENT, and
`cart doctor` names which ones and why. Nothing is ever guessed to
preserve the appearance of support.

## How it works

A Claude Code hook appends every session event, verbatim, to
`.coreartifact/spool.jsonl` in your repo. Ingestion (run by `log`/`show`
or the dashboard) projects the spool into a SQLite ledger: sessions,
commands, file touches, test results, checks, cost (derived from a
pinned price table and labeled as derived). The dashboard reads the
ledger over a local HTTP seam and renders the headline that matters for
delegated work: sessions **verified** (bound passing checks), **failing**
(bound failing checks), or **unverified** (no bound evidence).

## License

Apache-2.0. See LICENSE and NOTICE.

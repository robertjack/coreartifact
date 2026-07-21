# Security

## Reporting a vulnerability

Report vulnerabilities privately via GitHub's security advisories:
**Security → Report a vulnerability** on this repository. Please do not
open a public issue for a suspected vulnerability.

This is a pre-1.0 personal project: reports are read and taken
seriously, but there is no response-time commitment. Only the latest
release is supported.

## What this product promises

**Nothing leaves your machine.** coreartifact captures Claude Code
session events into a local spool and projects them into a local
ledger. No code, no transcripts, and no telemetry are transmitted by
default. The single exception is the explicit opt-in ping, which sends
an install id and nothing else. Anything that would weaken this law is
treated as a vulnerability, not a feature request.

The capture hook appends payloads verbatim and exits 0 — it executes
nothing from the payload and knows nothing about its contents. The
dashboard binds to localhost only.

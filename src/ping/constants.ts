// The weekly ping's two pinned constants (docs/issues/ISS-0023.md "The
// ping (R11)"). Both are named exports resolved directly by
// tests/acceptance/ISS-0023's resolveNamedExport helper — never hardcode a
// guessed value in a test, read it from here.

// Exactly seven days. A never-pinged state counts as older than this, so a
// fresh consent-on machine always gets exactly one immediate attempt.
export const PING_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// The receiver does not exist yet by design (packet "The ping (R11)") — the
// client fails silent on any transport error, and the URL is correctable
// any time before launch.
export const PING_ENDPOINT = "https://coreartifact.com/ping";

// The maximum extra time the CLI process may linger past the command
// handler's own completion waiting on an in-flight ping (fix for ISS-0023
// S2: "the process must not hold the event loop open past command
// completion"). The ping is started BEFORE the handler runs (src/cli/
// index.ts) so a healthy endpoint's round trip overlaps the command's own
// work and costs nothing; a stalled endpoint (still bounded by the
// transport's own 2000ms ceiling, transport.ts) costs at most this grace,
// never the full transport bound.
export const PING_EXIT_GRACE_MS = 250;

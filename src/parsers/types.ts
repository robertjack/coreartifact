// The parser interface (docs/issues/ISS-0018.md "The interface"). Pure,
// synchronous, ingest-side: parsers never run in the hook artifact, never
// see the transcript, never see a raw hook payload — only plain captured
// output text ingest has already extracted (src/ingest/testResults.ts).
//
// `null` means "not mine / unparsable" and the facet stays absent — a
// non-test command is not a degraded facet (schema.md degradation law).

export interface TestResults {
  passed: number;
  failed: number;
  skipped: number;
  /** Empty array when failed is 0 — never undefined, never omitted. */
  failedNames: string[];
  /** Absent (null) when unextractable from the captured text — never 0 as a stand-in. */
  durationMs: number | null;
}

export type Parser = (command: string | null, stdout: string, stderr: string, exit: number) => TestResults | null;

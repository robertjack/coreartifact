// Spool slicing + line-ordinal assignment (pure) — docs/issues/ISS-0006.md
// "The ingest algorithm (contract)", steps 2-4.
//
// Both functions operate on already-in-memory data (a byte buffer, a list
// of strings) with no I/O of their own, so the corrupt-line
// ordinal-stability property — a bad line still occupies its ordinal, and
// neighbors keep theirs — is testable without a real spool file.
//
// `NodeBuffer` re-types just the Buffer surface this module calls (`Buffer`
// itself is a @types/node ambient global unreachable in this sandbox — see
// src/core/ledger.ts's header for the same constraint and pattern). Any real
// Buffer instance (what `fs.readFileSync(path)` returns with no encoding
// argument) satisfies it structurally.
export interface NodeBuffer {
  indexOf(value: number, byteOffset?: number): number;
  subarray(start?: number, end?: number): NodeBuffer;
  toString(encoding: string): string;
  readonly length: number;
}

const NEWLINE = 0x0a;

export interface SlicedLines {
  /** Complete (newline-terminated) lines read from `startOffset`, in order. */
  lines: string[];
  /** Byte offset just past the last consumed newline — the new ingested_bytes. */
  endOffset: number;
}

// Reads complete lines starting at `startOffset`, stopping at the last
// complete line. A trailing partial line (no terminating \n) is left
// unconsumed — a hook may be mid-append (spec step 4). Slicing at the BYTE
// level (never decode-then-slice) is what keeps `ingested_bytes` a true
// byte offset even when a payload contains multi-byte UTF-8 characters.
export function sliceCompleteLines(buffer: NodeBuffer, startOffset: number): SlicedLines {
  const lines: string[] = [];
  let lineStart = startOffset;
  let searchFrom = startOffset;

  for (;;) {
    const newlineIndex = buffer.indexOf(NEWLINE, searchFrom);
    if (newlineIndex === -1) break;
    lines.push(buffer.subarray(lineStart, newlineIndex).toString("utf8"));
    lineStart = newlineIndex + 1;
    searchFrom = lineStart;
  }

  return { lines, endOffset: lineStart };
}

export interface OrdinalLine {
  lineNo: number;
  text: string;
}

// Assigns each raw line its 1-based physical-line ordinal, continuing from
// `startingLinesSeen` (spec: `line_no = lines_seen + 1`, then `lines_seen +=
// 1`, for every complete line including ones that will later fail to
// parse). A corrupt line among valid ones still consumes exactly one
// ordinal and does not shift its neighbors': index i always gets
// `startingLinesSeen + i + 1`, independent of what any other line contains.
export function assignLineOrdinals(startingLinesSeen: number, rawLines: string[]): OrdinalLine[] {
  return rawLines.map((text, index) => ({ lineNo: startingLinesSeen + index + 1, text }));
}

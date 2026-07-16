// The check output cap (docs/issues/ISS-0017.md "The output cap"). Head
// capture is deliberate — a check's primary signal is its exit code, and the
// opening lines carry the banner and first error. Truncation is always
// flagged, never silent, and never splits a multi-byte UTF-8 codepoint.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — Buffer is a module-local `declare const`, same
// pattern as src/ingest/index.ts, shaping only the surface this file calls.
interface NodeBufferLike {
  readonly length: number;
  [index: number]: number;
  subarray(start?: number, end?: number): NodeBufferLike;
  toString(encoding: string): string;
}
declare const Buffer: {
  from(input: string, encoding: string): NodeBufferLike;
};

export const CHECK_OUTPUT_CAP_BYTES = 32768;

export interface CapResult {
  output: string;
  truncated: boolean;
}

// A UTF-8 continuation byte has its top two bits set to `10`. Backing off
// while the byte immediately after the candidate cut point is a
// continuation byte finds the start of whatever multi-byte character
// straddles the cap, and excludes it wholesale rather than splitting it.
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

export function capOutput(raw: string): CapResult {
  const buf = Buffer.from(raw, "utf8");
  if (buf.length <= CHECK_OUTPUT_CAP_BYTES) {
    return { output: raw, truncated: false };
  }

  let end = CHECK_OUTPUT_CAP_BYTES;
  while (end > 0 && isContinuationByte(buf[end]!)) end--;

  return { output: buf.subarray(0, end).toString("utf8"), truncated: true };
}

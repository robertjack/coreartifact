import { describe, it, expect } from 'vitest';

const MODULE_PATH = '../../../src/core/envelope';

async function loadEnvelopeModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

describe('envelope', () => {
  it('parseEnvelope accepts a v1 envelope line and returns its ts and its event payload as the exact source text of the event member, byte-identical to the input slice; it rejects a line whose v is not 1, a line that is not JSON, and a line with no event member, returning a typed parse failure rather than throwing', async () => {
    const mod = await loadEnvelopeModule();
    if (!mod?.parseEnvelope) throw new Error('not implemented yet');
    const parseEnvelope = mod.parseEnvelope;

    // Key order (z before a) is deliberately non-canonical: a re-serialized
    // event would reorder these, so comparing the exact string catches that.
    const eventText = '{"hook_event_name":"PreToolUse","tool_name":"Bash","z":1,"a":2,"nested":{"b":true,"a":false}}';
    const line = `{"v":1,"ts":"2026-07-14T10:00:00.000Z","event":${eventText}}`;

    const result = parseEnvelope(line);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.envelope.ts).toBe('2026-07-14T10:00:00.000Z');
    expect(result.eventText).toBe(eventText);

    const badVersion = parseEnvelope('{"v":2,"ts":"2026-07-14T10:00:00.000Z","event":{"a":1}}');
    expect(badVersion.ok).toBe(false);
    if (badVersion.ok) throw new Error('expected err result for wrong v');
    expect(typeof badVersion.reason).toBe('string');

    const notJson = parseEnvelope('this is not json at all {{{');
    expect(notJson.ok).toBe(false);
    if (notJson.ok) throw new Error('expected err result for non-JSON line');

    const noEvent = parseEnvelope('{"v":1,"ts":"2026-07-14T10:00:00.000Z"}');
    expect(noEvent.ok).toBe(false);
    if (noEvent.ok) throw new Error('expected err result for missing event member');

    expect(() => parseEnvelope('{"v":1,"ts":"2026-07-14T10:00:00.000Z"}')).not.toThrow();
    expect(() => parseEnvelope('not json')).not.toThrow();
  });
});

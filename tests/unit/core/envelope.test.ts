import { describe, it, expect } from 'vitest';
import { parseEnvelope, serializeEnvelope } from '../../../src/core/envelope';

describe('envelope (unit)', () => {
  it('parses a boundary line carrying a git sibling with head and dirty present', () => {
    const line = '{"v":1,"ts":"2026-07-14T10:00:00.000Z","event":{"hook_event_name":"SessionStart"},"git":{"head":"abc123","dirty":false}}';
    const result = parseEnvelope(line);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.envelope.git).toEqual({ head: 'abc123', dirty: false });
  });

  it('treats a missing git sibling as absent (no git key on the envelope)', () => {
    const line = '{"v":1,"ts":"2026-07-14T10:00:00.000Z","event":{"hook_event_name":"PreToolUse"}}';
    const result = parseEnvelope(line);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.envelope.git).toBeUndefined();
  });

  it('rejects a top-level JSON array (not an object) without throwing', () => {
    const result = parseEnvelope('[1,2,3]');
    expect(result.ok).toBe(false);
  });

  it('extracts the exact event source text even when event is not the last member', () => {
    const eventText = '{"z":1,"nested":[1,2,{"a":"b}"}]}';
    const line = `{"v":1,"event":${eventText},"ts":"2026-07-14T10:00:00.000Z"}`;
    const result = parseEnvelope(line);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.eventText).toBe(eventText);
    expect(result.envelope.ts).toBe('2026-07-14T10:00:00.000Z');
  });

  it('serializeEnvelope embeds the raw event text verbatim and round-trips through parseEnvelope', () => {
    const eventText = '{"z":1,"a":2}';
    const line = serializeEnvelope({ ts: '2026-07-14T10:00:00.000Z', eventText, git: { head: 'deadbeef', dirty: true } });

    const result = parseEnvelope(line);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.eventText).toBe(eventText);
    expect(result.envelope.ts).toBe('2026-07-14T10:00:00.000Z');
    expect(result.envelope.git).toEqual({ head: 'deadbeef', dirty: true });
  });

  it('serializeEnvelope omits the git member entirely when not supplied', () => {
    const line = serializeEnvelope({ ts: '2026-07-14T10:00:00.000Z', eventText: '{"a":1}' });
    expect(line.includes('"git"')).toBe(false);
  });
});

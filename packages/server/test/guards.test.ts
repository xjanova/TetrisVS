import { describe, expect, it } from 'vitest';
import { MAX_ACTIONS, normalizeRoomCode, safeActions, sanitizeInput, shouldReap } from '../src/guards.js';

describe('safeActions', () => {
  it('keeps known actions and drops the rest', () => {
    expect(safeActions(['left', 'nope', 'hardDrop', 42, null])).toEqual(['left', 'hardDrop']);
  });

  it('deduplicates', () => {
    expect(safeActions(['left', 'left', 'left'])).toEqual(['left']);
  });

  it('never reads past the length cap', () => {
    const flood = new Array(200_000).fill('left');
    expect(safeActions(flood)).toEqual(['left']);
    const varied = new Array(200_000).fill('rotCW');
    varied[MAX_ACTIONS + 5] = 'hold';
    // 'hold' sits beyond the cap, so it must not survive.
    expect(safeActions(varied)).toEqual(['rotCW']);
  });

  it('tolerates non-arrays', () => {
    for (const value of [null, undefined, 'left', 7, {}, { length: 5 }]) {
      expect(safeActions(value)).toEqual([]);
    }
  });
});

describe('sanitizeInput', () => {
  it('normalises a well-formed payload', () => {
    expect(sanitizeInput({ frame: 12, pressed: ['hold'], held: ['left', 'softDrop'] }))
      .toEqual({ pressed: ['hold'], held: ['left', 'softDrop'] });
  });

  it('returns null instead of throwing on the payloads that used to crash the process', () => {
    for (const value of [null, undefined, 0, 'left', [], { frame: 1 }, { pressed: 'left' }]) {
      expect(() => sanitizeInput(value)).not.toThrow();
    }
    expect(sanitizeInput(null)).toBeNull();
    expect(sanitizeInput(undefined)).toBeNull();
    expect(sanitizeInput({ frame: 1 })).toBeNull();
  });

  it('accepts a payload with only one of the two lists', () => {
    expect(sanitizeInput({ pressed: ['hold'] })).toEqual({ pressed: ['hold'], held: [] });
    expect(sanitizeInput({ held: ['left'] })).toEqual({ pressed: [], held: ['left'] });
  });
});

describe('normalizeRoomCode', () => {
  it('accepts the codes the server actually mints', () => {
    expect(normalizeRoomCode('7ab840')).toBe('7AB840');
    expect(normalizeRoomCode('  7AB840  ')).toBe('7AB840');
  });

  it('rejects anything else without throwing', () => {
    for (const value of [null, undefined, 42, {}, [], '', 'ZZZZZZ', '7AB84', '7AB8400', 'x'.repeat(5000)]) {
      expect(() => normalizeRoomCode(value)).not.toThrow();
      expect(normalizeRoomCode(value)).toBeNull();
    }
  });
});

describe('shouldReap', () => {
  const FINISHED_TTL = 60_000;
  const IDLE_TTL = 600_000;

  it('reaps a room nobody is in', () => {
    expect(shouldReap({ empty: true, finished: false, idleMs: 0 }, FINISHED_TTL, IDLE_TTL)).toBe(true);
  });

  it('keeps a finished room briefly so clients can read the result', () => {
    expect(shouldReap({ empty: false, finished: true, idleMs: 5_000 }, FINISHED_TTL, IDLE_TTL)).toBe(false);
    expect(shouldReap({ empty: false, finished: true, idleMs: 61_000 }, FINISHED_TTL, IDLE_TTL)).toBe(true);
  });

  it('keeps a live room and reaps an abandoned one', () => {
    expect(shouldReap({ empty: false, finished: false, idleMs: 30_000 }, FINISHED_TTL, IDLE_TTL)).toBe(false);
    expect(shouldReap({ empty: false, finished: false, idleMs: 601_000 }, FINISHED_TTL, IDLE_TTL)).toBe(true);
  });
});

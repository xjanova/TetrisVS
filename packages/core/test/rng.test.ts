import { describe, expect, it } from 'vitest';
import { PIECE_TYPES, bagAt, mixSeed, nextPieces, pieceAt, xorshift32 } from '../src/index.js';

describe('7-bag RNG', () => {
  it('every bag is a permutation of all seven pieces', () => {
    for (let seed = 0; seed < 50; seed++) {
      for (let bag = 0; bag < 20; bag++) {
        const b = bagAt(seed * 7919 + 1, bag);
        expect(b.length).toBe(7);
        expect([...b].sort()).toEqual([...PIECE_TYPES].sort());
      }
    }
  });

  it('every window of 7 consecutive draws contains all 7 pieces', () => {
    const seed = 0xc0ffee;
    for (let start = 0; start < 70; start += 7) {
      const window = nextPieces(seed, start, 7);
      expect([...window].sort()).toEqual([...PIECE_TYPES].sort());
    }
  });

  it('is pure — same (seed, bagIndex, count) always gives the same answer', () => {
    const a = nextPieces(42, 13, 20);
    const b = nextPieces(42, 13, 20);
    expect(a).toEqual(b);
  });

  it('nextPieces at an offset matches a long sequential draw', () => {
    const seed = 987654321;
    const long = nextPieces(seed, 0, 60);
    for (let off = 0; off < 50; off++) {
      expect(nextPieces(seed, off, 10)).toEqual(long.slice(off, off + 10));
    }
  });

  it('pieceAt agrees with nextPieces', () => {
    const seed = 5150;
    for (let i = 0; i < 40; i++) {
      expect(pieceAt(seed, i)).toBe(nextPieces(seed, i, 1)[0]);
    }
  });

  it('different seeds produce different sequences', () => {
    const a = nextPieces(1, 0, 28).join('');
    const b = nextPieces(2, 0, 28).join('');
    expect(a).not.toBe(b);
  });

  it('crosses bag boundaries correctly', () => {
    const seed = 777;
    const spanning = nextPieces(seed, 5, 6); // 2 from bag 0, 4 from bag 1
    const bag0 = bagAt(seed, 0);
    const bag1 = bagAt(seed, 1);
    expect(spanning).toEqual([bag0[5], bag0[6], bag1[0], bag1[1], bag1[2], bag1[3]]);
  });

  it('xorshift32 never returns to zero and stays a uint32', () => {
    let s = 0;
    for (let i = 0; i < 1000; i++) {
      s = xorshift32(s);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it('mixSeed decorrelates adjacent bag numbers', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(mixSeed(1234, i));
    // Collisions would be a red flag for a 32-bit mixer over 500 inputs.
    expect(seen.size).toBeGreaterThan(495);
  });
});

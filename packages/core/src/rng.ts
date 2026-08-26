/**
 * Deterministic piece sequence.
 *
 * The whole point of this file: `nextPieces(seed, bagIndex, count)` is a PURE
 * function. Neither side has to transmit the piece queue over the network —
 * client and server both derive it from `(seed, bagIndex)` and are guaranteed
 * to agree. That removes one entire class of desync.
 *
 * No Math.random. No state. Integer arithmetic only.
 */

import { PIECE_TYPES, type PieceType } from './types.js';

/** xorshift32 — small, fast, and identical on every JS engine. */
export function xorshift32(s: number): number {
  let x = s >>> 0;
  // A zero state is absorbing for xorshift; nudge it off zero.
  if (x === 0) x = 0x9e3779b9;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x >>> 0;
}

/**
 * Mix a seed with a bag number into a well-distributed sub-seed.
 * Uses the finalizer from MurmurHash3 so that adjacent bag numbers do not
 * produce correlated shuffles.
 */
export function mixSeed(seed: number, bagNumber: number): number {
  let h = (seed ^ Math.imul(bagNumber + 1, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The 7-bag for a given bag number: a shuffled permutation of all seven pieces.
 * Fisher-Yates driven by xorshift32, so the same `(seed, bagNumber)` always
 * yields the same permutation on any machine.
 */
export function bagAt(seed: number, bagNumber: number): PieceType[] {
  const bag = PIECE_TYPES.slice();
  let s = mixSeed(seed, bagNumber);
  for (let i = bag.length - 1; i > 0; i--) {
    s = xorshift32(s);
    const j = s % (i + 1);
    const tmp = bag[i]!;
    bag[i] = bag[j]!;
    bag[j] = tmp;
  }
  return bag;
}

/**
 * `count` pieces starting at absolute draw index `bagIndex`.
 * PURE — the public contract relies on this never reading any state.
 */
export function nextPieces(seed: number, bagIndex: number, count: number): PieceType[] {
  if (count <= 0) return [];
  const out: PieceType[] = [];
  let idx = bagIndex;
  let bagNumber = Math.floor(idx / 7);
  let bag = bagAt(seed, bagNumber);
  while (out.length < count) {
    const offset = idx % 7;
    out.push(bag[offset]!);
    idx++;
    if (idx % 7 === 0) {
      bagNumber++;
      bag = bagAt(seed, bagNumber);
    }
  }
  return out;
}

/** The single piece at absolute draw index `bagIndex`. */
export function pieceAt(seed: number, bagIndex: number): PieceType {
  return nextPieces(seed, bagIndex, 1)[0]!;
}

/**
 * Deterministic garbage hole column, derived from the match seed and the
 * attacker's total attack count so both sides compute the same hole.
 */
export function garbageHole(seed: number, salt: number, width: number): number {
  return mixSeed(seed ^ 0x5bf03635, salt) % width;
}

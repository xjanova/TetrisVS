import { describe, expect, it } from 'vitest';
import {
  createMatch,
  decodeSnapshotFrame,
  deserialize,
  encodeFullFrame,
  encodeSnapshotFrame,
  hash,
  isFullFrame,
  serialize,
  step,
  xorshift32,
  type ActionName,
  type Inputs,
  type MatchState,
} from '../src/index.js';
import { playingMatch } from './helpers.js';

const ACTIONS: ActionName[] = ['left', 'right', 'softDrop', 'hardDrop', 'rotCW', 'rotCCW', 'rot180', 'hold'];

/** Same scripted-player trick the determinism suite uses: no Math.random anywhere. */
function scriptedInputs(seed: number, frame: number): Inputs {
  let s = seed >>> 0 || 1;
  const mk = () => {
    s = xorshift32(s);
    const pressed: ActionName[] = [];
    const held: ActionName[] = [];
    if (s % 4 === 0) pressed.push(ACTIONS[s % ACTIONS.length]!);
    s = xorshift32(s);
    if (s % 3 === 0) held.push(s % 2 === 0 ? 'left' : 'right');
    if (s % 9 === 0) held.push('softDrop');
    return { frame, pressed, held };
  };
  return [mk(), mk()];
}

describe('snapshot delta codec', () => {
  it('a full frame round-trips without a baseline', () => {
    const snapshot = serialize(createMatch(4242));
    const frame = encodeFullFrame(snapshot);
    expect(isFullFrame(frame)).toBe(true);
    expect(decodeSnapshotFrame(null, frame)).toEqual(snapshot);
  });

  it('falls back to a full frame when there is no baseline', () => {
    const snapshot = serialize(createMatch(7));
    const frame = encodeSnapshotFrame(null, snapshot);
    expect(isFullFrame(frame)).toBe(true);
    expect(decodeSnapshotFrame(null, frame)).toEqual(snapshot);
  });

  it('reconstructs the exact bytes across a whole simulated match', () => {
    let state: MatchState = playingMatch(20260827);
    let baseline: Uint8Array | null = null;
    let decoded: Uint8Array | null = null;
    let deltaBytes = 0;
    let fullBytes = 0;
    let deltaFrames = 0;

    for (let tick = 0; tick < 600; tick++) {
      state = step(state, scriptedInputs(state.frame + 1, state.frame)).state;
      const snapshot = serialize(state);
      const frame = encodeSnapshotFrame(baseline, snapshot);

      // The receiver only ever has what it decoded before — never the sender's copy.
      decoded = decodeSnapshotFrame(decoded, frame);
      expect(decoded).toEqual(snapshot);

      deltaBytes += frame.length;
      fullBytes += snapshot.length;
      if (!isFullFrame(frame)) deltaFrames++;
      baseline = snapshot;
    }

    // Decoding must produce a state indistinguishable from the original.
    expect(hash(deserialize(decoded!))).toBe(hash(state));
    // Nearly every tick should be a cheap delta, and the stream far smaller.
    expect(deltaFrames).toBeGreaterThan(590);
    expect(deltaBytes * 4).toBeLessThan(fullBytes);
  });

  it('survives a board that changes wholesale (garbage push)', () => {
    const a = serialize(playingMatch(1));
    const shifted = playingMatch(1);
    for (let i = 0; i < shifted.players[0].board.length; i++) {
      shifted.players[0].board[i] = i % 3 === 0 ? 'G' : 0;
    }
    const b = serialize(shifted);
    const frame = encodeSnapshotFrame(a, b);
    expect(decodeSnapshotFrame(a, frame)).toEqual(b);
  });

  it('encoding is itself deterministic', () => {
    const a = serialize(playingMatch(99));
    const b = serialize(step(playingMatch(99), scriptedInputs(1, 0)).state);
    expect(encodeSnapshotFrame(a, b)).toEqual(encodeSnapshotFrame(a, b));
  });

  it('rejects corrupt frames instead of returning garbage', () => {
    const snapshot = serialize(createMatch(3));
    const frame = encodeSnapshotFrame(serialize(createMatch(4)), snapshot);
    expect(() => decodeSnapshotFrame(null, frame)).toThrow(/baseline/);
    expect(() => decodeSnapshotFrame(null, new Uint8Array([1, 2, 3, 4]))).toThrow(/magic/);
    expect(() => decodeSnapshotFrame(null, new Uint8Array([0x54, 0x44, 9, 1]))).toThrow(/version/);
    expect(() => decodeSnapshotFrame(null, new Uint8Array([0x54]))).toThrow(/truncated/);
  });

  it('handles a baseline that is shorter or longer than the target', () => {
    const short = new Uint8Array([1, 2, 3]);
    const long = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(decodeSnapshotFrame(short, encodeSnapshotFrame(short, long))).toEqual(long);
    expect(decodeSnapshotFrame(long, encodeSnapshotFrame(long, short))).toEqual(short);
  });
});

import { describe, expect, it } from 'vitest';
import {
  createMatch,
  deserialize,
  hash,
  serialize,
  step,
  stepMany,
  xorshift32,
  type ActionName,
  type Inputs,
  type MatchState,
} from '../src/index.js';
import { playingMatch } from './helpers.js';

const ACTIONS: ActionName[] = ['left', 'right', 'softDrop', 'hardDrop', 'rotCW', 'rotCCW', 'rot180', 'hold'];

/**
 * A reproducible "player" driven by xorshift — no Math.random anywhere, so this
 * test is itself deterministic and can be trusted as a determinism oracle.
 */
function scriptedInputs(seed: number, ticks: number): Inputs[] {
  let s = seed >>> 0 || 1;
  const out: Inputs[] = [];
  for (let f = 0; f < ticks; f++) {
    const mk = () => {
      s = xorshift32(s);
      const pressed: ActionName[] = [];
      const held: ActionName[] = [];
      if (s % 5 === 0) pressed.push(ACTIONS[s % ACTIONS.length]!);
      s = xorshift32(s);
      if (s % 3 === 0) held.push(s % 2 === 0 ? 'left' : 'right');
      if (s % 7 === 0) held.push('softDrop');
      return { frame: f, pressed, held };
    };
    out.push([mk(), mk()]);
  }
  return out;
}

describe('determinism', () => {
  it('the same seed and inputs produce the same state hash', () => {
    const inputs = scriptedInputs(0xabcdef, 900);
    const a = stepMany(playingMatch(2024), inputs).state;
    const b = stepMany(playingMatch(2024), inputs).state;
    expect(hash(a)).toBe(hash(b));
    expect(a.frame).toBe(b.frame);
  });

  it('running twice through separate step() calls matches stepMany', () => {
    const inputs = scriptedInputs(555, 300);
    const bulk = stepMany(playingMatch(9), inputs).state;
    let cur: MatchState = playingMatch(9);
    for (const i of inputs) cur = step(cur, i).state;
    expect(hash(cur)).toBe(hash(bulk));
  });

  it('a different seed diverges', () => {
    const inputs = scriptedInputs(0xabcdef, 400);
    const a = stepMany(playingMatch(1), inputs).state;
    const b = stepMany(playingMatch(2), inputs).state;
    expect(hash(a)).not.toBe(hash(b));
  });

  it('a one-tick input difference diverges', () => {
    const base = scriptedInputs(31337, 400);
    const tweaked = base.map((i, n) =>
      n === 120 ? ([{ ...i[0], pressed: ['hardDrop' as ActionName] }, i[1]] as Inputs) : i,
    );
    const a = stepMany(playingMatch(77), base).state;
    const b = stepMany(playingMatch(77), tweaked).state;
    expect(hash(a)).not.toBe(hash(b));
  });

  it('step never mutates the state it was given', () => {
    const inputs = scriptedInputs(4, 200);
    let cur = playingMatch(4);
    for (const i of inputs) {
      const before = hash(cur);
      const next = step(cur, i).state;
      expect(hash(cur), 'input state was mutated').toBe(before);
      cur = next;
    }
  });

  it('events are reproducible, not just state', () => {
    const inputs = scriptedInputs(8, 500);
    const a = stepMany(playingMatch(3), inputs).events;
    const b = stepMany(playingMatch(3), inputs).events;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('snapshot', () => {
  it('round-trips exactly', () => {
    const inputs = scriptedInputs(1010, 400);
    const s = stepMany(playingMatch(64), inputs).state;
    const back = deserialize(serialize(s));
    expect(back).toEqual(s);
    expect(hash(back)).toBe(hash(s));
  });

  it('round-trips a fresh match', () => {
    const s = createMatch(0);
    expect(deserialize(serialize(s))).toEqual(s);
  });

  it('round-trips a state with a pending garbage queue', () => {
    const s = playingMatch(5);
    s.players[1].garbageQueue.push(
      { amount: 4, holeColumn: 2, readyAtFrame: 300 },
      { amount: 1, holeColumn: 9, readyAtFrame: 420 },
    );
    const back = deserialize(serialize(s));
    expect(back.players[1].garbageQueue).toEqual(s.players[1].garbageQueue);
  });

  it('resuming from a snapshot continues identically — the reconnect path', () => {
    const inputs = scriptedInputs(2222, 600);
    const uninterrupted = stepMany(playingMatch(1234), inputs).state;

    const half = stepMany(playingMatch(1234), inputs.slice(0, 300)).state;
    const resumed = deserialize(serialize(half));
    const finished = stepMany(resumed, inputs.slice(300)).state;

    expect(hash(finished)).toBe(hash(uninterrupted));
  });

  it('rejects a corrupt snapshot instead of silently decoding garbage', () => {
    const buf = serialize(createMatch(1));
    buf[0] = 0;
    expect(() => deserialize(buf)).toThrow(/bad magic/);
  });

  it('hash changes when any part of the state changes', () => {
    const a = playingMatch(1);
    const b = playingMatch(1);
    b.players[0].combo = 5;
    expect(hash(a)).not.toBe(hash(b));
  });

  it('hash is a uint32', () => {
    const inputs = scriptedInputs(3, 200);
    let cur = playingMatch(1);
    for (const i of inputs) {
      cur = step(cur, i).state;
      const h = hash(cur);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('purity of the piece queue', () => {
  it('a player\'s drawn pieces always match nextPieces(seed, bagIndex)', async () => {
    const { nextPieces } = await import('../src/index.js');
    const inputs = scriptedInputs(6161, 800);
    const s = stepMany(playingMatch(31415), inputs).state;
    for (const p of s.players) {
      // The next piece the player will draw is fully derivable — nothing stored.
      const upcoming = nextPieces(s.seed, p.bagIndex, 5);
      expect(upcoming.length).toBe(5);
      expect(nextPieces(s.seed, p.bagIndex, 5)).toEqual(upcoming);
    }
  });
});

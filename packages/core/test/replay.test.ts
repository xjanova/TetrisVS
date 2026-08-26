import { describe, expect, it } from 'vitest';
import {
  REPLAY_ACTIONS,
  ReplayRecorder,
  actionsOf,
  createMatch,
  decodeReplay,
  encodeReplay,
  hash,
  maskOf,
  packTick,
  replayInputs,
  step,
  stepMany,
  unpackTick,
  xorshift32,
  type ActionName,
  type Inputs,
} from '../src/index.js';

const ACTIONS: ActionName[] = [...REPLAY_ACTIONS];

/** Deterministic scripted player — no Math.random, so this test is its own oracle. */
function scripted(seed: number, frame: number): Inputs {
  let s = seed >>> 0 || 1;
  const mk = () => {
    s = xorshift32(s);
    const pressed: ActionName[] = [];
    const held: ActionName[] = [];
    if (s % 5 === 0) pressed.push(ACTIONS[s % ACTIONS.length]!);
    s = xorshift32(s);
    if (s % 3 === 0) held.push(s % 2 === 0 ? 'left' : 'right');
    if (s % 8 === 0) held.push('softDrop');
    return { frame, pressed, held };
  };
  return [mk(), mk()];
}

describe('action masks', () => {
  it('round-trips every subset it will ever see', () => {
    for (let mask = 0; mask < 256; mask++) {
      expect(maskOf(actionsOf(mask))).toBe(mask);
    }
  });

  it('packs both players into one word without collision', () => {
    const inputs: Inputs = [
      { frame: 0, pressed: ['hardDrop'], held: ['left'] },
      { frame: 0, pressed: ['hold', 'rotCW'], held: ['softDrop', 'right'] },
    ];
    const word = packTick(inputs);
    const back = unpackTick(word, 0);
    expect(back[0].pressed).toEqual(['hardDrop']);
    expect(back[0].held).toEqual(['left']);
    expect(back[1].pressed).toEqual(['rotCW', 'hold']);
    expect(back[1].held).toEqual(['right', 'softDrop']);
  });

  it('ignores actions it does not know', () => {
    expect(maskOf(['left', 'nonsense' as ActionName])).toBe(maskOf(['left']));
  });
});

describe('replay codec', () => {
  it('round-trips an empty log', () => {
    expect(decodeReplay(encodeReplay([]))).toEqual([]);
  });

  it('round-trips arbitrary words', () => {
    const words = [0, 1, 1, 1, 0xffffffff, 0xffffffff, 7, 0, 0, 0, 0, 256];
    expect(decodeReplay(encodeReplay(words))).toEqual(words);
  });

  it('collapses idle stretches hard', () => {
    const words = new Array(36_000).fill(0);
    const encoded = encodeReplay(words);
    // An hour of nothing must not cost more than a handful of bytes.
    expect(encoded.length).toBeLessThan(16);
    expect(decodeReplay(encoded)).toEqual(words);
  });

  it('rejects corrupt input instead of returning garbage', () => {
    expect(() => decodeReplay(new Uint8Array([1, 2, 3]))).toThrow(/magic/);
    expect(() => decodeReplay(new Uint8Array([0x54, 0x52, 9]))).toThrow(/version/);
    expect(() => decodeReplay(new Uint8Array([0x54]))).toThrow(/truncated/);
    const good = encodeReplay([1, 1, 1]);
    expect(() => decodeReplay(new Uint8Array([...good, 0]))).toThrow(/trailing/);
  });

  it('is itself deterministic', () => {
    const words = [3, 3, 9, 0, 0, 0, 5];
    expect(encodeReplay(words)).toEqual(encodeReplay(words));
  });
});

describe('a replay reproduces the match exactly', () => {
  it('final state hashes match, cell for cell', () => {
    const seed = 20260827;
    const recorder = new ReplayRecorder();

    let live = createMatch(seed);
    for (let tick = 0; tick < 1200; tick++) {
      const inputs = scripted(live.frame + 1, live.frame);
      recorder.record(inputs);
      live = step(live, inputs).state;
      if (live.status === 'finished') break;
    }

    const bytes = recorder.encode();
    const replayed = stepMany(createMatch(seed), replayInputs(decodeReplay(bytes))).state;

    expect(hash(replayed)).toBe(hash(live));
    expect(replayed.frame).toBe(live.frame);
    expect(replayed.players[0].board).toEqual(live.players[0].board);
    expect(replayed.players[1].board).toEqual(live.players[1].board);
    expect(replayed.winner).toBe(live.winner);
  });

  it('stays small — a real match is kilobytes, not megabytes', () => {
    const recorder = new ReplayRecorder();
    let state = createMatch(31337);
    for (let tick = 0; tick < 10_800; tick++) { // three minutes at 60 Hz
      const inputs = scripted(state.frame + 1, state.frame);
      recorder.record(inputs);
      state = step(state, inputs).state;
      if (state.status === 'finished') break;
    }
    const bytes = recorder.encode();
    const raw = recorder.ticks * 4;
    expect(bytes.length).toBeLessThan(raw);
    expect(bytes.length).toBeLessThan(64 * 1024);
    expect(decodeReplay(bytes).length).toBe(recorder.ticks);
  });

  it('a recorder can be reused after reset', () => {
    const recorder = new ReplayRecorder();
    recorder.record([{ frame: 0, pressed: ['hold'], held: [] }, { frame: 0, pressed: [], held: [] }]);
    expect(recorder.ticks).toBe(1);
    recorder.reset();
    expect(recorder.ticks).toBe(0);
    expect(decodeReplay(recorder.encode())).toEqual([]);
  });
});

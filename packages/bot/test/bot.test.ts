import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  createMatch,
  hash,
  idleInput,
  step,
  type ActionName,
  type Inputs,
  type MatchConfig,
  type MatchState,
} from '@tetrisvs/core';
import { Bot, DIFFICULTIES, DIFFICULTY_ORDER, botInputs, isDifficulty, rankPlacements, DELLACHERIE } from '../src/index.js';

const SOLO: MatchConfig = { ...DEFAULT_CONFIG, solo: true };
const VALID: ReadonlySet<string> = new Set<ActionName>([
  'left', 'right', 'softDrop', 'hardDrop', 'rotCW', 'rotCCW', 'rot180', 'hold',
]);

interface RunResult {
  frames: number;
  lines: number;
  pieces: number;
  finished: boolean;
  state: MatchState;
}

/** Let a bot play seat 0 alone for up to `maxFrames`. */
function solo(seed: number, difficulty: keyof typeof DIFFICULTIES, maxFrames = 12_000): RunResult {
  const bot = new Bot(0, DIFFICULTIES[difficulty]);
  let state = createMatch(seed, SOLO);
  let pieces = 0;
  let frame = 0;

  for (; frame < maxFrames; frame++) {
    const thought = bot.think(state);
    for (const action of thought.pressed) expect(VALID.has(action)).toBe(true);
    if (thought.pressed.includes('hardDrop')) pieces++;
    const inputs: Inputs = [thought, idleInput(state.frame)];
    state = step(state, inputs, SOLO).state;
    if (state.status === 'finished') break;
  }

  return {
    frames: frame,
    lines: state.players[0].linesCleared,
    pieces,
    finished: state.status === 'finished',
    state,
  };
}

describe('difficulty table', () => {
  it('names round-trip', () => {
    for (const name of DIFFICULTY_ORDER) expect(isDifficulty(name)).toBe(true);
    for (const value of [null, undefined, 42, 'godlike', '']) expect(isDifficulty(value)).toBe(false);
  });

  it('every knob means exactly one thing — nothing doubles as an off switch', () => {
    for (const name of DIFFICULTY_ORDER) {
      const config = DIFFICULTIES[name];
      // A reaction of 0 would be ambiguous with "no delay configured".
      expect(config.reactionTicks).toBeGreaterThanOrEqual(1);
      expect(config.mistakeRate).toBeGreaterThanOrEqual(0);
      expect(config.mistakeRate).toBeLessThanOrEqual(1);
      expect(config.mistakeDepth).toBeGreaterThanOrEqual(1);
    }
    // Exactly 0 is the only way to say "never makes a mistake".
    expect(DIFFICULTIES.ruthless.mistakeRate).toBe(0);
  });

  it('gets monotonically faster and more accurate', () => {
    for (let i = 1; i < DIFFICULTY_ORDER.length; i++) {
      const easier = DIFFICULTIES[DIFFICULTY_ORDER[i - 1]!];
      const harder = DIFFICULTIES[DIFFICULTY_ORDER[i]!];
      expect(harder.reactionTicks).toBeLessThanOrEqual(easier.reactionTicks);
      expect(harder.mistakeRate).toBeLessThanOrEqual(easier.mistakeRate);
    }
  });
});

describe('placement search', () => {
  it('finds somewhere to put every piece on an empty board', () => {
    for (const type of ['I', 'J', 'L', 'O', 'S', 'T', 'Z'] as const) {
      const ranked = rankPlacements(createMatch(1).players[0].board, type, null, { weights: DELLACHERIE, useHold: false });
      expect(ranked.length).toBeGreaterThan(3);
      for (const placement of ranked) {
        expect(placement.actions[placement.actions.length - 1]).toBe('hardDrop');
        for (const action of placement.actions) expect(VALID.has(action)).toBe(true);
      }
    }
  });

  it('does not fabricate hold placements when hold is off', () => {
    const board = createMatch(1).players[0].board;
    const ranked = rankPlacements(board, 'T', 'I', { weights: DELLACHERIE, useHold: false });
    expect(ranked.every((placement) => !placement.useHold)).toBe(true);
  });

  it('offers hold placements when it is on and the pieces differ', () => {
    const board = createMatch(1).players[0].board;
    const ranked = rankPlacements(board, 'T', 'I', { weights: DELLACHERIE, useHold: true });
    expect(ranked.some((placement) => placement.useHold)).toBe(true);
    // Holding the piece you already have is not a move.
    const same = rankPlacements(board, 'T', 'T', { weights: DELLACHERIE, useHold: true });
    expect(same.every((placement) => !placement.useHold)).toBe(true);
  });

  it('prefers not to make holes', () => {
    const board = createMatch(1).players[0].board;
    const ranked = rankPlacements(board, 'I', null, { weights: DELLACHERIE, useHold: false });
    expect(ranked[0]!.features.holes).toBe(0);
  });
});

describe('the bot actually plays', () => {
  it('a sideways tap actually moves the piece', () => {
    // Regression: the first version sent the action only in `pressed`. The
    // simulation reads its direction from `held`, so every slide was a no-op
    // and the bot stacked all seven pieces into the spawn column.
    const bot = new Bot(0, DIFFICULTIES.ruthless);
    let state = createMatch(1, SOLO);
    while (state.status === 'countdown') state = step(state, [idleInput(state.frame), idleInput(state.frame)], SOLO).state;
    state = step(state, [idleInput(state.frame), idleInput(state.frame)], SOLO).state;

    const thought = bot.think(state);
    const slide = thought.pressed.find((action) => action === 'left' || action === 'right');
    if (slide) {
      expect(thought.held).toContain(slide);
      const before = state.players[0].active!.x;
      const after = step(state, [thought, idleInput(state.frame)], SOLO).state.players[0].active!.x;
      expect(after).not.toBe(before);
    }
  });

  it('spreads pieces across the board instead of towering in one column', () => {
    const run = solo(31337, 'ruthless', 2500);
    const columns = new Set<number>();
    const board = run.state.players[0].board;
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 10; x++) if (board[y * 10 + x] !== 0) columns.add(x);
    }
    // A bot that cannot move sideways occupies three or four columns forever.
    expect(run.pieces).toBeGreaterThan(50);
    expect(run.state.players[0].linesCleared).toBeGreaterThan(5);
    // A bot that cannot slide occupies four columns; a working one uses the board.
    expect(columns.size).toBeGreaterThan(4);
  }, 20_000);

  it('survives long enough to be an opponent, and clears lines doing it', () => {
    const run = solo(20260827, 'ruthless', 6000);
    // 6,000 ticks is 100 seconds. A bot that stacks badly tops out in ten.
    expect(run.pieces).toBeGreaterThan(60);
    expect(run.lines).toBeGreaterThan(50);
    expect(run.finished).toBe(false);
  }, 20_000);

  it('is deterministic — the same seed plays the same game twice', () => {
    const a = solo(4242, 'sharp', 2000);
    const b = solo(4242, 'sharp', 2000);
    expect(hash(a.state)).toBe(hash(b.state));
    expect(a.lines).toBe(b.lines);
    expect(a.frames).toBe(b.frames);
  }, 20_000);

  it('a harder setting clears more than an easier one over the same run', () => {
    const seeds = [11, 22, 33];
    const rookie = seeds.reduce((sum, seed) => sum + solo(seed, 'rookie', 3000).lines, 0);
    const ruthless = seeds.reduce((sum, seed) => sum + solo(seed, 'ruthless', 3000).lines, 0);
    expect(ruthless).toBeGreaterThan(rookie);
  }, 30_000);

  it('searches once per piece, not once per tick', () => {
    // This is the property that keeps the bot affordable: the client calls
    // think() sixty times a second, but a placement search only happens when a
    // new piece needs a plan.
    //
    // Asserted as a count rather than a stopwatch on purpose. An earlier
    // version measured milliseconds and passed alone while failing in the full
    // suite — under load the median swung from 0.7 ms to 9 ms, so it was
    // measuring the machine, not the bot. Wall-clock cost now lives in
    // `npm run bench -w @tetrisvs/bot`, where it is read rather than enforced.
    const bot = new Bot(0, DIFFICULTIES.ruthless);
    let state = createMatch(20260827, SOLO);
    let pieces = 0;
    let ticks = 0;

    for (; ticks < 3000; ticks++) {
      const thought = bot.think(state);
      if (thought.pressed.includes('hardDrop')) pieces++;
      state = step(state, [thought, idleInput(state.frame)], SOLO).state;
      if (state.status === 'finished') break;
    }

    expect(pieces).toBeGreaterThan(30);
    // One search per piece, plus a few for hold swaps changing the signature.
    expect(bot.searches).toBeLessThan(pieces * 3);
    // ...and dramatically fewer than the number of ticks.
    expect(bot.searches).toBeLessThan(ticks / 4);
  }, 20_000);

  it('never emits an action outside the contract, on any board', () => {
    const bot = new Bot(1, DIFFICULTIES.sharp);
    let state = createMatch(7);
    for (let i = 0; i < 2000; i++) {
      const thought = bot.think(state);
      expect(thought.frame).toBe(state.frame);
      expect(Array.isArray(thought.pressed)).toBe(true);
      expect(Array.isArray(thought.held)).toBe(true);
      for (const action of [...thought.pressed, ...thought.held]) expect(VALID.has(action)).toBe(true);
      state = step(state, botInputs(bot, state, idleInput(state.frame))).state;
      if (state.status === 'finished') break;
    }
  });

  it('keeps its head when garbage arrives', () => {
    const bot = new Bot(0, DIFFICULTIES.sharp);
    let state = createMatch(5, SOLO);
    for (let i = 0; i < 600; i++) {
      state = step(state, [bot.think(state), idleInput(state.frame)], SOLO).state;
    }
    // Shove a wall of garbage under the bot mid-game.
    const board = state.players[0].board;
    for (let y = 30; y < 40; y++) {
      for (let x = 0; x < 10; x++) board[y * 10 + x] = x === 3 ? 0 : 'G';
    }
    expect(() => {
      for (let i = 0; i < 600; i++) {
        state = step(state, [bot.think(state), idleInput(state.frame)], SOLO).state;
        if (state.status === 'finished') break;
      }
    }).not.toThrow();
  });

  it('reset() forgets the plan so a rematch does not inherit one', () => {
    const bot = new Bot(0, DIFFICULTIES.sharp);
    let state = createMatch(9, SOLO);
    for (let i = 0; i < 200; i++) state = step(state, [bot.think(state), idleInput(state.frame)], SOLO).state;
    expect(bot.intent).not.toBeNull();
    bot.reset();
    const fresh = createMatch(9, SOLO);
    expect(() => bot.think(fresh)).not.toThrow();
  });

  it('does nothing at all before the countdown ends or after a top-out', () => {
    const bot = new Bot(0, DIFFICULTIES.ruthless);
    const counting = createMatch(3, SOLO);
    expect(counting.status).toBe('countdown');
    expect(bot.think(counting).pressed).toEqual([]);

    const dead = createMatch(3, SOLO);
    dead.status = 'finished';
    expect(bot.think(dead).pressed).toEqual([]);
  });

  it('plays either seat', () => {
    const bot = new Bot(1, DIFFICULTIES.sharp);
    let state = createMatch(13);
    for (let i = 0; i < 1500; i++) {
      state = step(state, botInputs(bot, state, idleInput(state.frame))).state;
      if (state.status === 'finished') break;
    }
    // Seat 1 is the one that has been building a stack.
    expect(state.players[1].bagIndex).toBeGreaterThan(state.players[0].bagIndex);
  });
});

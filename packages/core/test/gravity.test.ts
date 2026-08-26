import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  TICK_HZ,
  gravityAt,
  hash,
  levelAt,
  step,
  type MatchConfig,
} from '../src/index.js';
import { advance, idle, playingMatch } from './helpers.js';

const RAMP = DEFAULT_CONFIG.gravityRampEveryTicks;

describe('gravityAt', () => {
  it('starts at the configured interval', () => {
    expect(gravityAt(0)).toBe(DEFAULT_CONFIG.gravityTicks);
    expect(gravityAt(RAMP - 1)).toBe(DEFAULT_CONFIG.gravityTicks);
  });

  it('shortens by one step per ramp period', () => {
    expect(gravityAt(RAMP)).toBe(DEFAULT_CONFIG.gravityTicks - DEFAULT_CONFIG.gravityRampStepTicks);
    expect(gravityAt(RAMP * 3)).toBe(DEFAULT_CONFIG.gravityTicks - DEFAULT_CONFIG.gravityRampStepTicks * 3);
  });

  it('never falls below the floor, however long the match runs', () => {
    for (const frame of [RAMP * 20, RAMP * 500, 2 ** 30]) {
      expect(gravityAt(frame)).toBe(DEFAULT_CONFIG.gravityMinTicks);
    }
  });

  it('is monotonic and integral', () => {
    let previous = gravityAt(0);
    for (let frame = 0; frame < RAMP * 12; frame += 97) {
      const value = gravityAt(frame);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('can be switched off entirely', () => {
    const flat: MatchConfig = { ...DEFAULT_CONFIG, gravityRampEveryTicks: 0 };
    expect(gravityAt(RAMP * 40, flat)).toBe(flat.gravityTicks);
    expect(levelAt(RAMP * 40, flat)).toBe(1);
  });

  it('treats a negative frame as the start of the match', () => {
    expect(gravityAt(-500)).toBe(DEFAULT_CONFIG.gravityTicks);
  });
});

describe('levelAt', () => {
  it('is 1-based and stops climbing once gravity bottoms out', () => {
    expect(levelAt(0)).toBe(1);
    expect(levelAt(RAMP)).toBe(2);
    const maxLevel = levelAt(2 ** 30);
    expect(levelAt(RAMP * 1000)).toBe(maxLevel);
    expect(gravityAt(RAMP * (maxLevel - 1))).toBe(DEFAULT_CONFIG.gravityMinTicks);
  });
});

describe('the ramp inside step()', () => {
  it('makes pieces fall faster later in the match', () => {
    const fallTicks = (startFrame: number) => {
      let state = playingMatch(77);
      state = { ...state, frame: startFrame };
      state = step(state, idle(state.frame)).state; // spawn
      const startY = state.players[0].active!.y;
      let ticks = 0;
      while (state.players[0].active && state.players[0].active.y === startY && ticks < 400) {
        state = step(state, idle(state.frame)).state;
        ticks++;
      }
      return ticks;
    };

    const early = fallTicks(0);
    const late = fallTicks(RAMP * 6);
    expect(late).toBeLessThan(early);
  });

  it('stays deterministic — two runs from the same seed still agree', () => {
    const run = () => hash(advance({ ...playingMatch(4242), frame: RAMP * 4 }, 240));
    expect(run()).toBe(run());
  });

  it('a match at the gravity floor still locks pieces', () => {
    let state = { ...playingMatch(9), frame: RAMP * 40 };
    let locks = 0;
    for (let i = 0; i < TICK_HZ * 10 && locks === 0; i++) {
      const result = step(state, idle(state.frame));
      locks += result.events.filter((event) => event.t === 'lock').length;
      state = result.state;
    }
    expect(locks).toBeGreaterThan(0);
  });
});

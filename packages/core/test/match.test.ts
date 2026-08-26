import { describe, expect, it } from 'vitest';
import {
  BOARD_H_TOTAL,
  BOARD_W,
  DEFAULT_CONFIG,
  TICK_HZ,
  createMatch,
  getCell,
  pieceCells,
  step,
  type ActionName,
  type CoreEvent,
  type MatchState,
} from '../src/index.js';
import { advance, fillRow, idle, only, playingMatch, setCell } from './helpers.js';

function ev<T extends CoreEvent['t']>(events: CoreEvent[], t: T): Extract<CoreEvent, { t: T }>[] {
  return events.filter((e) => e.t === t) as Extract<CoreEvent, { t: T }>[];
}

describe('match lifecycle', () => {
  it('starts in countdown and switches to playing', () => {
    let s = createMatch(1);
    expect(s.status).toBe('countdown');
    s = advance(s, DEFAULT_CONFIG.countdownTicks);
    expect(s.status).toBe('countdown');
    const r = step(s, idle(s.frame));
    expect(r.state.status).toBe('playing');
  });

  it('emits a countdown tick once per second', () => {
    let s = createMatch(1);
    const seen: number[] = [];
    for (let i = 0; i < DEFAULT_CONFIG.countdownTicks + 1; i++) {
      const r = step(s, idle(s.frame));
      for (const e of ev(r.events, 'countdown')) seen.push(e.value);
      s = r.state;
    }
    expect(seen).toEqual([3, 2, 1, 0]);
    expect(DEFAULT_CONFIG.countdownTicks / TICK_HZ).toBe(3);
  });

  it('spawns a piece for both players and the piece matches the bag', () => {
    const s = playingMatch(4242);
    const r = step(s, idle(s.frame));
    const spawns = ev(r.events, 'spawn');
    expect(spawns.length).toBe(2);
    expect(r.state.players[0].active).not.toBeNull();
    expect(r.state.players[1].active).not.toBeNull();
    expect(r.state.players[0].bagIndex).toBe(1);
  });

  it('does not mutate the state passed in', () => {
    const s = playingMatch(7);
    const before = JSON.stringify(s);
    step(s, only(0, s.frame, ['hardDrop']));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('piece control', () => {
  it('a tap moves exactly one cell', () => {
    let s = playingMatch(11);
    s = step(s, idle(s.frame)).state;
    const x0 = s.players[0].active!.x;
    const r = step(s, only(0, s.frame, ['left'], ['left']));
    expect(r.state.players[0].active!.x).toBe(x0 - 1);
    expect(ev(r.events, 'move').length).toBe(1);
  });

  it('holding a direction repeats after DAS', () => {
    let s = playingMatch(11);
    s = step(s, idle(s.frame)).state;
    const x0 = s.players[0].active!.x;
    s = step(s, only(0, s.frame, ['left'], ['left'])).state; // tap
    for (let i = 0; i < 20; i++) {
      s = step(s, only(0, s.frame, [], ['left'])).state; // held only
    }
    expect(s.players[0].active!.x).toBeLessThan(x0 - 1);
  });

  it('never lets a piece leave the playfield, however hard you mash', () => {
    let s = playingMatch(11);
    for (let i = 0; i < 400; i++) {
      const dir: ActionName = i % 2 === 0 ? 'left' : 'right';
      s = step(s, only(0, s.frame, [dir, 'rotCW'], [dir])).state;
      const a = s.players[0].active;
      if (!a) continue;
      for (const c of pieceCells(a.type, a.rot, a.x, a.y)) {
        expect(c.x, `tick ${i}: cell escaped left/right`).toBeGreaterThanOrEqual(0);
        expect(c.x, `tick ${i}: cell escaped left/right`).toBeLessThan(BOARD_W);
        expect(c.y, `tick ${i}: cell escaped the floor`).toBeLessThan(BOARD_H_TOTAL);
      }
    }
  });

  it('hold swaps the piece, and a second hold on the same piece is denied', () => {
    let s = playingMatch(99);
    s = step(s, idle(s.frame)).state;
    const first = s.players[0].active!.type;

    let r = step(s, only(0, s.frame, ['hold']));
    expect(ev(r.events, 'hold').length).toBe(1);
    expect(r.state.players[0].hold).toBe(first);
    expect(r.state.players[0].active!.type).not.toBe(undefined);
    expect(r.state.players[0].holdUsed).toBe(true);

    r = step(r.state, only(0, r.state.frame, ['hold']));
    expect(ev(r.events, 'holdDenied').length).toBe(1);
  });

  it('hard drop locks the piece immediately and emits the distance', () => {
    let s = playingMatch(3);
    s = step(s, idle(s.frame)).state;
    const r = step(s, only(0, s.frame, ['hardDrop']));
    expect(ev(r.events, 'hardDrop').length).toBe(1);
    expect(ev(r.events, 'lock').length).toBe(1);
    expect(r.state.players[0].active).toBeNull();
    expect(ev(r.events, 'hardDrop')[0]!.cells).toBeGreaterThan(0);
  });

  it('a piece eventually locks by gravity alone', () => {
    let s = playingMatch(3);
    s = step(s, idle(s.frame)).state;
    let locks = 0;
    for (let i = 0; i < 60 * 30; i++) {
      const r = step(s, idle(s.frame));
      locks += ev(r.events, 'lock').length;
      s = r.state;
      if (locks > 0) break;
    }
    expect(locks).toBeGreaterThan(0);
  });
});

describe('line clears and attack', () => {
  function doubleSetup(seed = 5): MatchState {
    const s = playingMatch(seed);
    const p = s.players[0];
    fillRow(p.board, 38, [0, 1]);
    fillRow(p.board, 39, [0, 1]);
    // One stray block so the double is NOT also a perfect clear — otherwise the
    // perfect-clear bonus swamps the numbers this suite is trying to pin down.
    setCell(p.board, 9, 36, 'G');
    p.active = { type: 'O', rot: 0, x: 0, y: 37 };
    p.spawnTicks = 0;
    return s;
  }

  it('clears two rows and reports a double', () => {
    const s = doubleSetup();
    const r = step(s, only(0, s.frame, ['hardDrop']));
    const clears = ev(r.events, 'lineClear');
    expect(clears.length).toBe(1);
    expect(clears[0]!.kind).toBe('double');
    expect(clears[0]!.rows).toEqual([38, 39]);
    expect(r.state.players[0].linesCleared).toBe(2);
    expect(r.state.players[0].combo).toBe(0);
  });

  it('sends garbage to the opponent with a telegraph', () => {
    const s = doubleSetup();
    const r = step(s, only(0, s.frame, ['hardDrop']));
    const attacks = ev(r.events, 'attack');
    expect(attacks.length).toBe(1);
    expect(attacks[0]!.to).toBe(1);
    expect(attacks[0]!.amount).toBeGreaterThan(0);

    const incoming = ev(r.events, 'garbageIncoming');
    expect(incoming.length).toBe(1);
    expect(incoming[0]!.readyAtFrame).toBe(s.frame + DEFAULT_CONFIG.garbageDelayTicks);
    expect(r.state.players[1].garbageQueue.length).toBe(1);
  });

  it('an outgoing attack cancels pending incoming garbage first', () => {
    const s = doubleSetup();
    s.players[0].garbageQueue.push({ amount: 3, holeColumn: 5, readyAtFrame: s.frame + 999 });
    const r = step(s, only(0, s.frame, ['hardDrop']));

    const cancelled = ev(r.events, 'garbageCancelled');
    expect(cancelled.length).toBeGreaterThan(0);
    expect(r.state.players[0].garbageQueue[0]!.amount).toBeLessThan(3);
    // fully absorbed by the cancel, so nothing reached the opponent
    expect(r.state.players[1].garbageQueue.length).toBe(0);
  });

  it('garbage lands only when a lock clears nothing', () => {
    const s = playingMatch(6);
    const p = s.players[0];
    p.garbageQueue.push({ amount: 2, holeColumn: 3, readyAtFrame: 0 });
    p.active = { type: 'O', rot: 0, x: 0, y: 20 };
    p.spawnTicks = 0;

    const r = step(s, only(0, s.frame, ['hardDrop']));
    const applied = ev(r.events, 'garbageApplied');
    expect(applied.length).toBe(1);
    expect(applied[0]!.amount).toBe(2);
    expect(getCell(r.state.players[0].board, 3, 39)).toBe(0); // the hole
    expect(getCell(r.state.players[0].board, 4, 39)).toBe('G');
    expect(r.state.players[0].garbageQueue.length).toBe(0);
  });

  it('garbage that is still telegraphed does not land yet', () => {
    const s = playingMatch(6);
    const p = s.players[0];
    p.garbageQueue.push({ amount: 2, holeColumn: 3, readyAtFrame: s.frame + 500 });
    p.active = { type: 'O', rot: 0, x: 0, y: 20 };
    p.spawnTicks = 0;

    const r = step(s, only(0, s.frame, ['hardDrop']));
    expect(ev(r.events, 'garbageApplied').length).toBe(0);
    expect(r.state.players[0].garbageQueue.length).toBe(1);
  });

  it('a clear starts a combo and a blank lock ends it', () => {
    let s = doubleSetup(8);
    let r = step(s, only(0, s.frame, ['hardDrop']));
    expect(r.state.players[0].combo).toBe(0);

    s = r.state;
    s.players[0].active = { type: 'O', rot: 0, x: 0, y: 20 };
    s.players[0].spawnTicks = 0;
    r = step(s, only(0, s.frame, ['hardDrop']));
    expect(r.state.players[0].combo).toBe(-1);
  });

  it('back-to-back turns on for a tetris and breaks on a plain clear', () => {
    const s = playingMatch(21);
    const p = s.players[0];
    for (const y of [36, 37, 38, 39]) fillRow(p.board, y, [0]);
    // I at rot 1 occupies box column 2, so x = -2 puts the bar in board column 0.
    p.active = { type: 'I', rot: 1, x: -2, y: 36 };
    p.spawnTicks = 0;

    const r = step(s, only(0, s.frame, ['hardDrop']));
    const clears = ev(r.events, 'lineClear');
    expect(clears.length).toBe(1);
    expect(clears[0]!.kind).toBe('tetris');
    expect(ev(r.events, 'b2bUp').length).toBe(1);
    expect(r.state.players[0].backToBack).toBe(true);
  });
});

describe('T-spin, end to end through step()', () => {
  /**
   * A real T-slot:
   *
   *   37  . . . . . . # . . .      <- overhang at column 6
   *   38  # # # # # # . . . #
   *   39  # # # # # # # . # #
   *
   * A T at rot 2 with its box at (6, 37) fills (6,38) (7,38) (8,38) and (7,39),
   * completing both rows.
   */
  function tSlot(seed = 17): MatchState {
    const s = playingMatch(seed);
    const p = s.players[0];
    fillRow(p.board, 39, [7]);
    fillRow(p.board, 38, [6, 7, 8]);
    setCell(p.board, 6, 37, 'G');
    p.spawnTicks = 0;
    return s;
  }

  it('rotating INTO the slot scores a T-spin double', () => {
    const s = tSlot();
    // T sits in the mouth of the slot; a 180 drops it straight in with no kick.
    s.players[0].active = { type: 'T', rot: 0, x: 6, y: 37 };

    const r = step(s, only(0, s.frame, ['rot180', 'hardDrop']));
    const clears = ev(r.events, 'lineClear');
    expect(clears.length).toBe(1);
    expect(clears[0]!.kind).toBe('tspin-double');
    expect(clears[0]!.rows).toEqual([38, 39]);
    expect(ev(r.events, 'b2bUp').length).toBe(1);
    expect(ev(r.events, 'attack')[0]!.amount).toBeGreaterThanOrEqual(4);
  });

  it('the slot cannot be entered by dropping — the overhang stops the piece', () => {
    const s = tSlot();
    // Correct orientation, but coming straight down from above.
    s.players[0].active = { type: 'T', rot: 2, x: 6, y: 34 };

    const r = step(s, only(0, s.frame, ['hardDrop']));
    expect(ev(r.events, 'hardDrop')[0]!.cells).toBeGreaterThan(0);
    // It lands on the overhang, so neither row completes. That is what makes
    // this a genuine T-slot rather than an ordinary well.
    expect(ev(r.events, 'lineClear').length).toBe(0);
  });

  it('landing in the slot without rotating last is only a plain double', () => {
    const s = tSlot();
    // Already in the final position and orientation, but nothing rotated it there.
    s.players[0].active = { type: 'T', rot: 2, x: 6, y: 37 };

    const r = step(s, only(0, s.frame, ['hardDrop']));
    expect(ev(r.events, 'hardDrop')[0]!.cells).toBe(0);
    const clears = ev(r.events, 'lineClear');
    expect(clears.length).toBe(1);
    expect(clears[0]!.kind).toBe('double');
  });
});

describe('topout', () => {
  it('a blocked spawn kills the player and ends the match', () => {
    const s = playingMatch(31);
    const p = s.players[0];
    for (let y = 16; y < 24; y++) fillRow(p.board, y);
    p.active = null;
    p.spawnTicks = 0;

    const r = step(s, idle(s.frame));
    expect(ev(r.events, 'topout').length).toBe(1);
    expect(r.state.players[0].alive).toBe(false);
    expect(r.state.status).toBe('finished');
    expect(r.state.winner).toBe(1);
  });

  it('a finished match ignores further input', () => {
    let s = playingMatch(31);
    const p = s.players[0];
    for (let y = 16; y < 24; y++) fillRow(p.board, y);
    p.active = null;
    s = step(s, idle(s.frame)).state;
    expect(s.status).toBe('finished');

    const frozen = JSON.stringify(s.players);
    const actions: ActionName[] = ['hardDrop', 'left', 'rotCW'];
    const r = step(s, only(1, s.frame, actions, actions));
    expect(JSON.stringify(r.state.players)).toBe(frozen);
    expect(r.events.length).toBe(0);
  });
});

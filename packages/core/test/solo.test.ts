import { describe, expect, it } from 'vitest';
import { BOARD_W, DEFAULT_CONFIG, createMatch, hash, idx, step, type MatchConfig } from '../src/index.js';
import { advance, fillRow, idle, only, playingMatch } from './helpers.js';

const SOLO: MatchConfig = { ...DEFAULT_CONFIG, solo: true };

describe('solo mode', () => {
  it('leaves seat 1 completely untouched', () => {
    let state = playingMatch(2026, SOLO);
    const before = JSON.stringify(state.players[1]);
    state = advance(state, 600, SOLO);
    expect(JSON.stringify(state.players[1])).toBe(before);
    // ...while seat 0 has been playing all along.
    expect(state.players[0].active ?? state.players[0].board.some((cell) => cell !== 0)).toBeTruthy();
  });

  it('ignores inputs aimed at seat 1', () => {
    let state = playingMatch(7, SOLO);
    state = step(state, idle(state.frame), SOLO).state;
    const quiet = JSON.stringify(state.players[1]);
    for (let i = 0; i < 30; i++) {
      state = step(state, only(1, state.frame, ['hardDrop', 'rotCW'], ['left']), SOLO).state;
    }
    expect(JSON.stringify(state.players[1])).toBe(quiet);
  });

  it('does not end when seat 1 is out — in versus that is instantly a win', () => {
    // Same starting position, one dead seat 1.
    const versus = playingMatch(11);
    versus.players[1].alive = false;
    const versusResult = step(versus, idle(versus.frame));
    expect(versusResult.state.status).toBe('finished');
    expect(versusResult.state.winner).toBe(0);

    const solo = playingMatch(11, SOLO);
    solo.players[1].alive = false;
    expect(step(solo, idle(solo.frame), SOLO).state.status).toBe('playing');
    // ...and it keeps going for as long as seat 0 survives.
    expect(advance(solo, 1800, SOLO).status).toBe('playing');
  });

  it('ends with no winner when the one player tops out', () => {
    const state = playingMatch(3, SOLO);
    // Fill seat 0's board right up to the spawn zone.
    for (let y = 2; y < 40; y++) fillRow(state.players[0].board, y);
    const result = step(state, idle(state.frame), SOLO);
    expect(result.state.status).toBe('finished');
    expect(result.state.winner).toBeNull();
    expect(result.events.some((event) => event.t === 'topout' && event.p === 0)).toBe(true);
    expect(result.events.some((event) => event.t === 'matchEnd')).toBe(true);
  });

  it('still sends no garbage anywhere — there is nobody to send it to', () => {
    const state = playingMatch(5, SOLO);
    const board = state.players[0].board;
    fillRow(board, 39, [0]);
    fillRow(board, 38, [0]);
    board[idx(0, 37)] = 'I';
    let current = state;
    let attacks = 0;
    for (let i = 0; i < 300; i++) {
      const result = step(current, idle(current.frame), SOLO);
      attacks += result.events.filter((event) => event.t === 'attack').length;
      current = result.state;
      if (current.status === 'finished') break;
    }
    expect(attacks).toBe(0);
    expect(current.players[1].garbageQueue).toHaveLength(0);
  });

  it('is deterministic like every other mode', () => {
    const run = () => hash(advance(playingMatch(4242, SOLO), 400, SOLO));
    expect(run()).toBe(run());
  });

  it('a solo match and a versus match from the same seed diverge only at seat 1', () => {
    const soloState = advance(playingMatch(99, SOLO), 120, SOLO);
    const versusState = advance(playingMatch(99), 120);
    // Seat 0 sees identical pieces and identical gravity.
    expect(soloState.players[0].board).toEqual(versusState.players[0].board);
    expect(soloState.players[0].bagIndex).toBe(versusState.players[0].bagIndex);
  });

  it('createMatch is unchanged — solo lives in the config, not the state', () => {
    expect(createMatch(1)).toEqual(createMatch(1, SOLO));
    expect(BOARD_W).toBe(10);
  });
});

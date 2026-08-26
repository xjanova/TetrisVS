import { describe, expect, it } from 'vitest';
import { classifyClear, detectTSpin, emptyBoard, type PlayerState } from '../src/index.js';
import { setCell } from './helpers.js';

/**
 * T at rot 2 (flat side up, nub pointing down) placed with its bounding box at
 * (x, y) has its centre at (x+1, y+1). The four diagonal corners are therefore
 * (x, y), (x+2, y), (x, y+2), (x+2, y+2).
 *
 * For rot 2 the FRONT corners are the lower pair: (x, y+2) and (x+2, y+2).
 */
function tState(corners: { x: number; y: number }[], lastAction: PlayerState['lastAction'], kick = 0): PlayerState {
  const board = emptyBoard();
  for (const c of corners) setCell(board, c.x, c.y, 'G');
  return {
    board,
    active: null,
    hold: null,
    holdUsed: false,
    bagIndex: 0,
    garbageQueue: [],
    combo: -1,
    backToBack: false,
    linesCleared: 0,
    attackSent: 0,
    alive: true,
    lastAction,
    lastKickIndex: kick,
    gravityTicks: 0,
    lockTicks: 0,
    lockResets: 0,
    dasTicks: 0,
    arrTicks: 0,
    spawnTicks: 0,
  };
}

const PIECE = { type: 'T' as const, rot: 2 as const, x: 3, y: 37 };
// centre (4, 38); corners (3,37) (5,37) (3,39) (5,39); front = (3,39) (5,39)

describe('T-spin detection', () => {
  it('needs the last action to be a rotation', () => {
    const p = tState([{ x: 3, y: 37 }, { x: 5, y: 37 }, { x: 3, y: 39 }, { x: 5, y: 39 }], 'move');
    expect(detectTSpin(p, PIECE).tspin).toBe(false);
  });

  it('needs at least 3 blocked corners', () => {
    const p = tState([{ x: 3, y: 37 }, { x: 5, y: 37 }], 'rotate');
    expect(detectTSpin(p, PIECE).tspin).toBe(false);
  });

  it('3 corners with only 1 front corner blocked is a mini', () => {
    const p = tState([{ x: 3, y: 37 }, { x: 5, y: 37 }, { x: 3, y: 39 }], 'rotate');
    const r = detectTSpin(p, PIECE);
    expect(r.tspin).toBe(true);
    expect(r.mini).toBe(true);
  });

  it('both front corners blocked is a full T-spin', () => {
    const p = tState([{ x: 3, y: 37 }, { x: 3, y: 39 }, { x: 5, y: 39 }], 'rotate');
    const r = detectTSpin(p, PIECE);
    expect(r.tspin).toBe(true);
    expect(r.mini).toBe(false);
  });

  it('all four corners blocked is a full T-spin', () => {
    const p = tState([{ x: 3, y: 37 }, { x: 5, y: 37 }, { x: 3, y: 39 }, { x: 5, y: 39 }], 'rotate');
    const r = detectTSpin(p, PIECE);
    expect(r.tspin).toBe(true);
    expect(r.mini).toBe(false);
  });

  it('the final SRS kick promotes a mini to a full T-spin', () => {
    const p = tState([{ x: 3, y: 37 }, { x: 5, y: 37 }, { x: 3, y: 39 }], 'rotate', 4);
    const r = detectTSpin(p, PIECE);
    expect(r.tspin).toBe(true);
    expect(r.mini).toBe(false);
  });

  it('a non-T piece is never a T-spin', () => {
    const p = tState([{ x: 3, y: 37 }, { x: 5, y: 37 }, { x: 3, y: 39 }, { x: 5, y: 39 }], 'rotate');
    expect(detectTSpin(p, { type: 'S', rot: 2, x: 3, y: 37 }).tspin).toBe(false);
  });

  it('walls count as blocked corners', () => {
    // Push the T against the left wall: bounding box at x = -1 puts two corners
    // outside the playfield, which SRS treats as solid.
    const p = tState([{ x: 1, y: 39 }], 'rotate');
    const r = detectTSpin(p, { type: 'T', rot: 2, x: -1, y: 37 });
    // corners: (-1,37) wall, (1,37) empty, (-1,39) wall, (1,39) filled => 3 blocked
    expect(r.tspin).toBe(true);
  });
});

describe('classifyClear', () => {
  it('maps plain clears', () => {
    expect(classifyClear(1, false, false)).toBe('single');
    expect(classifyClear(2, false, false)).toBe('double');
    expect(classifyClear(3, false, false)).toBe('triple');
    expect(classifyClear(4, false, false)).toBe('tetris');
  });

  it('maps T-spin clears', () => {
    expect(classifyClear(1, true, true)).toBe('tspin-mini');
    expect(classifyClear(1, true, false)).toBe('tspin-single');
    expect(classifyClear(2, true, false)).toBe('tspin-double');
    expect(classifyClear(3, true, false)).toBe('tspin-triple');
  });

  it('returns null when nothing cleared', () => {
    expect(classifyClear(0, false, false)).toBeNull();
    expect(classifyClear(0, true, false)).toBeNull();
  });
});

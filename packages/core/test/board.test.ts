import { describe, expect, it } from 'vitest';
import {
  BOARD_H_TOTAL,
  BOARD_W,
  clearFullRows,
  collides,
  dropDistance,
  emptyBoard,
  getCell,
  ghostPosition,
  idx,
  isBlocked,
  isBoardEmpty,
  pushGarbage,
  spawnPiece,
  stackTop,
  visibleRows,
} from '../src/index.js';
import { fillRow, setCell } from './helpers.js';

describe('board', () => {
  it('starts empty and the right size', () => {
    const b = emptyBoard();
    expect(b.length).toBe(BOARD_W * BOARD_H_TOTAL);
    expect(isBoardEmpty(b)).toBe(true);
    expect(stackTop(b)).toBe(BOARD_H_TOTAL);
  });

  it('treats walls and floor as blocked, open air above as free', () => {
    const b = emptyBoard();
    expect(isBlocked(b, -1, 30)).toBe(true);
    expect(isBlocked(b, BOARD_W, 30)).toBe(true);
    expect(isBlocked(b, 5, BOARD_H_TOTAL)).toBe(true);
    expect(isBlocked(b, 5, -1)).toBe(false);
    expect(isBlocked(b, 5, 30)).toBe(false);
  });

  it('getCell is bounds-safe', () => {
    const b = emptyBoard();
    setCell(b, 3, 30, 'T');
    expect(getCell(b, 3, 30)).toBe('T');
    expect(getCell(b, -1, 30)).toBe(0);
    expect(getCell(b, 3, BOARD_H_TOTAL + 5)).toBe(0);
  });

  it('clears full rows and collapses the stack downward', () => {
    const b = emptyBoard();
    fillRow(b, 39);
    fillRow(b, 38);
    setCell(b, 4, 37, 'T'); // a lone block above
    const cleared = clearFullRows(b);
    expect(cleared).toEqual([38, 39]);
    // the lone block should now sit on the floor
    expect(getCell(b, 4, 39)).toBe('T');
    expect(getCell(b, 4, 37)).toBe(0);
  });

  it('does not clear a row with a hole', () => {
    const b = emptyBoard();
    fillRow(b, 39, [7]);
    expect(clearFullRows(b)).toEqual([]);
    expect(getCell(b, 7, 39)).toBe(0);
  });

  it('clears non-contiguous rows correctly', () => {
    const b = emptyBoard();
    fillRow(b, 39);
    fillRow(b, 37);
    setCell(b, 0, 38, 'S');
    const cleared = clearFullRows(b);
    expect(cleared).toEqual([37, 39]);
    expect(getCell(b, 0, 39)).toBe('S');
  });

  it('pushes garbage in from the bottom with exactly one hole per row', () => {
    const b = emptyBoard();
    pushGarbage(b, 3, 4);
    for (let r = 0; r < 3; r++) {
      const y = BOARD_H_TOTAL - 1 - r;
      let holes = 0;
      for (let x = 0; x < BOARD_W; x++) {
        if (b[idx(x, y)] === 0) holes++;
        else expect(b[idx(x, y)]).toBe('G');
      }
      expect(holes, `row ${y}`).toBe(1);
      expect(b[idx(4, y)]).toBe(0);
    }
    expect(stackTop(b)).toBe(BOARD_H_TOTAL - 3);
  });

  it('garbage lifts the existing stack up', () => {
    const b = emptyBoard();
    setCell(b, 0, 39, 'T');
    pushGarbage(b, 2, 9);
    expect(getCell(b, 0, 37)).toBe('T');
    expect(getCell(b, 0, 39)).toBe('G');
  });

  it('dropDistance and ghostPosition agree and land on the floor', () => {
    const b = emptyBoard();
    const p = spawnPiece('O');
    const d = dropDistance(b, p);
    const g = ghostPosition(b, p);
    expect(g.y).toBe(p.y + d);
    expect(collides(b, g.type, g.rot, g.x, g.y)).toBe(false);
    expect(collides(b, g.type, g.rot, g.x, g.y + 1)).toBe(true);
  });

  it('visibleRows returns exactly the bottom 20 rows', () => {
    const b = emptyBoard();
    setCell(b, 0, BOARD_H_TOTAL - 1, 'I');
    const rows = visibleRows(b);
    expect(rows.length).toBe(20);
    expect(rows[19]![0]).toBe('I');
  });
});

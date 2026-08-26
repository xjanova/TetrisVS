import {
  BOARD_H_TOTAL,
  BOARD_W,
  DEFAULT_CONFIG,
  createMatch,
  idleInputs,
  idx,
  step,
  type ActionName,
  type Board,
  type Cell,
  type Inputs,
  type MatchConfig,
  type MatchState,
  type PlayerId,
  type PlayerInput,
} from '../src/index.js';

/** A match already past the countdown, with both players ready to spawn immediately. */
export function playingMatch(seed = 12345, config: MatchConfig = DEFAULT_CONFIG): MatchState {
  const s = createMatch(seed, config);
  s.status = 'playing';
  s.players[0].spawnTicks = 0;
  s.players[1].spawnTicks = 0;
  return s;
}

export function input(frame: number, pressed: ActionName[] = [], held: ActionName[] = []): PlayerInput {
  return { frame, pressed, held };
}

/** Inputs where only player `p` acts. */
export function only(p: PlayerId, frame: number, pressed: ActionName[] = [], held: ActionName[] = []): Inputs {
  const a = input(frame, pressed, held);
  const b = input(frame);
  return p === 0 ? [a, b] : [b, a];
}

export function idle(frame: number): Inputs {
  return idleInputs(frame);
}

/** Run `n` idle ticks. */
export function advance(s: MatchState, n: number, config: MatchConfig = DEFAULT_CONFIG): MatchState {
  let cur = s;
  for (let i = 0; i < n; i++) cur = step(cur, idle(cur.frame), config).state;
  return cur;
}

/** Fill a row, leaving the listed columns empty. */
export function fillRow(board: Board, y: number, emptyCols: number[] = [], cell: Cell = 'G'): void {
  for (let x = 0; x < BOARD_W; x++) {
    board[idx(x, y)] = emptyCols.includes(x) ? 0 : cell;
  }
}

export function setCell(board: Board, x: number, y: number, cell: Cell): void {
  board[idx(x, y)] = cell;
}

/** ASCII dump of the bottom `rows` rows — for eyeballing a failing test. */
export function dump(board: Board, rows = 8): string {
  const out: string[] = [];
  for (let y = BOARD_H_TOTAL - rows; y < BOARD_H_TOTAL; y++) {
    let line = '';
    for (let x = 0; x < BOARD_W; x++) {
      const c = board[idx(x, y)];
      line += c === 0 ? '.' : c === 'G' ? '#' : String(c);
    }
    out.push(`${String(y).padStart(2, '0')} ${line}`);
  }
  return out.join('\n');
}

/**
 * Scoring and personal bests.
 *
 * Score is derived from `CoreEvent`s rather than stored in `MatchState` on
 * purpose: it is a presentation concern, and adding a field to the state would
 * change the snapshot format that the wire protocol, the replay codec, and the
 * database all depend on. Every input to the calculation is already in the
 * event stream, so the two can never disagree.
 */

import type { ClearKind, CoreEvent, PlayerId } from '@tetrisvs/core';

/** Base points per clear, before level, back-to-back, and combo. */
const BASE: Record<ClearKind, number> = {
  single: 100,
  double: 300,
  triple: 500,
  tetris: 800,
  'tspin-mini': 100,
  'tspin-single': 800,
  'tspin-double': 1200,
  'tspin-triple': 1600,
  'perfect-clear': 2000,
};

const B2B_MULTIPLIER = 1.5;
const COMBO_POINTS = 50;
const SOFT_DROP_POINTS = 1;
const HARD_DROP_POINTS = 2;

export interface RunScore {
  score: number;
  lines: number;
  /** Longest combo reached this run. */
  bestCombo: number;
  /** Biggest single clear, for the result screen. */
  bestClear: ClearKind | null;
  tetrises: number;
  tSpins: number;
  perfectClears: number;
}

export function emptyScore(): RunScore {
  return { score: 0, lines: 0, bestCombo: 0, bestClear: null, tetrises: 0, tSpins: 0, perfectClears: 0 };
}

const RANK: ClearKind[] = [
  'single', 'tspin-mini', 'double', 'triple', 'tspin-single', 'tetris',
  'tspin-double', 'tspin-triple', 'perfect-clear',
];

/**
 * Fold a batch of events into a running score.
 *
 * Returns a new object rather than mutating, so React state updates stay
 * honest. `level` scales the clear points the way the genre expects — the same
 * `levelAt(frame)` the simulation uses for gravity, so points and speed climb
 * together.
 */
export function applyScore(
  current: RunScore,
  events: readonly CoreEvent[],
  seat: PlayerId,
  level: number,
): RunScore {
  let { score, lines, bestCombo, bestClear, tetrises, tSpins, perfectClears } = current;
  let changed = false;

  for (const event of events) {
    if (!('p' in event) || event.p !== seat) continue;

    if (event.t === 'lineClear') {
      const base = BASE[event.kind] ?? 0;
      // `b2b` on the event is the state *before* this clear, which is exactly
      // the run the bonus should reward.
      const multiplier = event.b2b ? B2B_MULTIPLIER : 1;
      score += Math.round(base * multiplier * Math.max(1, level));
      if (event.combo > 0) score += COMBO_POINTS * event.combo * Math.max(1, level);
      lines += event.rows.length;
      if (event.combo > bestCombo) bestCombo = event.combo;
      if (event.kind === 'tetris') tetrises++;
      if (event.kind.startsWith('tspin')) tSpins++;
      if (bestClear === null || RANK.indexOf(event.kind) > RANK.indexOf(bestClear)) bestClear = event.kind;
      changed = true;
    } else if (event.t === 'softDrop') {
      score += SOFT_DROP_POINTS * event.cells;
      changed = true;
    } else if (event.t === 'hardDrop') {
      score += HARD_DROP_POINTS * event.cells;
      changed = true;
    }
  }

  // Perfect clears arrive as their own kind; count them separately so the
  // result screen can call them out.
  for (const event of events) {
    if ('p' in event && event.p === seat && event.t === 'lineClear' && event.kind === 'perfect-clear') {
      perfectClears++;
      changed = true;
    }
  }

  if (!changed) return current;
  return { score, lines, bestCombo, bestClear, tetrises, tSpins, perfectClears };
}

// ---------------------------------------------------------------- best runs

export interface PersonalBest {
  score: number;
  lines: number;
  frames: number;
  at: number;
}

const BEST_KEY = 'tetrisvs.best';

/** Reading storage throws in some privacy modes; no best is not an error. */
export function loadBest(): PersonalBest | null {
  try {
    const raw = window.localStorage.getItem(BEST_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Partial<PersonalBest>;
    if (typeof value.score !== 'number' || !Number.isFinite(value.score)) return null;
    return {
      score: value.score,
      lines: typeof value.lines === 'number' ? value.lines : 0,
      frames: typeof value.frames === 'number' ? value.frames : 0,
      at: typeof value.at === 'number' ? value.at : 0,
    };
  } catch {
    return null;
  }
}

/** Store a run if it beats the stored one. Returns true when it was a record. */
export function saveBest(run: PersonalBest): boolean {
  const existing = loadBest();
  if (existing && existing.score >= run.score) return false;
  try {
    window.localStorage.setItem(BEST_KEY, JSON.stringify(run));
  } catch {
    // The record still stands for this session, it just will not survive a reload.
  }
  return true;
}

export function formatScore(score: number): string {
  return score.toLocaleString('en-US');
}

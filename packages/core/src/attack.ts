/**
 * Scoring of a clear into outgoing garbage.
 *
 * Numbers are guideline-flavoured; they live here alone so they can be retuned
 * without touching state shape, `step()`, or anything the client compiles against.
 */

import type { ClearKind } from './types.js';

/** Base garbage per clear kind, before B2B and combo. */
export const BASE_ATTACK: Record<ClearKind, number> = {
  single: 0,
  double: 1,
  triple: 2,
  tetris: 4,
  'tspin-mini': 0,
  'tspin-single': 2,
  'tspin-double': 4,
  'tspin-triple': 6,
  'perfect-clear': 10,
};

/** Extra garbage while back-to-back is live. */
export const B2B_BONUS = 1;

/** Combo bonus indexed by combo count (0 = first clear of the chain). Clamped at the end. */
export const COMBO_TABLE: readonly number[] = [0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 5];

/** Clears that keep back-to-back alive. */
export function isB2BClear(kind: ClearKind): boolean {
  return kind === 'tetris' || kind.startsWith('tspin');
}

/** A clear that breaks a running B2B chain (any non-T-spin clear under 4 lines). */
export function breaksB2B(kind: ClearKind): boolean {
  return !isB2BClear(kind) && kind !== 'perfect-clear';
}

export function comboBonus(combo: number): number {
  if (combo <= 0) return 0;
  const i = Math.min(combo, COMBO_TABLE.length - 1);
  return COMBO_TABLE[i]!;
}

export interface AttackInput {
  kind: ClearKind;
  /** B2B state BEFORE this clear. */
  b2bActive: boolean;
  /** Combo count for this clear (0 for the first clear of a chain). */
  combo: number;
  /** Whether this clear emptied the board. */
  perfectClear: boolean;
}

/** Total garbage this clear sends. Always a non-negative integer. */
export function attackFor(input: AttackInput): number {
  let n = BASE_ATTACK[input.kind];
  if (input.b2bActive && isB2BClear(input.kind)) n += B2B_BONUS;
  n += comboBonus(input.combo);
  if (input.perfectClear) n += BASE_ATTACK['perfect-clear'];
  return n < 0 ? 0 : n;
}

/**
 * Classify a clear.
 * `tspin` / `tspinMini` come from the T-spin detector in match.ts; this
 * function only turns (lines, tspin flags) into a `ClearKind`.
 */
export function classifyClear(lines: number, tspin: boolean, tspinMini: boolean): ClearKind | null {
  if (lines <= 0) return null;
  if (tspin) {
    if (tspinMini && lines === 1) return 'tspin-mini';
    if (lines === 1) return 'tspin-single';
    if (lines === 2) return 'tspin-double';
    return 'tspin-triple';
  }
  if (lines === 1) return 'single';
  if (lines === 2) return 'double';
  if (lines === 3) return 'triple';
  return 'tetris';
}

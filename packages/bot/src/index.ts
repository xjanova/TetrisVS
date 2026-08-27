/**
 * @tetrisvs/bot — an opponent that plays by pressing keys.
 *
 * The bot reads a `MatchState` and returns a `PlayerInput`. It has no other
 * powers: it cannot place a piece, cannot see the opponent's next queue, and
 * cannot skip the lock delay. Anything it does is something a player could
 * have done with the same keyboard, which is what makes an AI match record and
 * replay exactly like a human one.
 *
 * Difficulty is *not* achieved by making the evaluator worse at maths. It is
 * three separate, honest handicaps: how often the bot may press a key, how
 * often it deliberately takes a worse placement, and whether it is allowed to
 * use hold at all. Each knob means one thing only — no value doubles as a
 * sentinel for "off".
 */

import {
  nextPieces,
  xorshift32,
  type ActionName,
  type MatchState,
  type PlayerId,
  type PlayerInput,
} from '@tetrisvs/core';
import { DELLACHERIE, type EvaluationWeights } from './evaluate.js';
import { rankPlacements, type Placement } from './plan.js';

export { DELLACHERIE, measure, score, type EvaluationWeights, type Features } from './evaluate.js';
export { candidates, rankPlacements, type Placement, type SearchOptions } from './plan.js';

export interface BotConfig {
  /** How the bot judges a board. */
  weights: EvaluationWeights;
  /**
   * Ticks between keystrokes. 1 is a key every frame — inhumanly fast; 12 is
   * slow enough that gravity sometimes locks the piece before the plan
   * finishes, which is a real and visible weakness.
   */
  reactionTicks: number;
  /**
   * Chance per piece of taking a deliberately worse placement, 0 to 1.
   * Exactly 0 means "never" — it is not overloaded to mean anything else.
   */
  mistakeRate: number;
  /** How far down the ranking a mistake may reach. */
  mistakeDepth: number;
  /** Allowed to press hold. */
  useHold: boolean;
}

export type Difficulty = 'rookie' | 'steady' | 'sharp' | 'ruthless';

export const DIFFICULTIES: Record<Difficulty, BotConfig> = {
  rookie: { weights: DELLACHERIE, reactionTicks: 11, mistakeRate: 0.4, mistakeDepth: 14, useHold: false },
  steady: { weights: DELLACHERIE, reactionTicks: 6, mistakeRate: 0.18, mistakeDepth: 8, useHold: true },
  sharp: { weights: DELLACHERIE, reactionTicks: 3, mistakeRate: 0.05, mistakeDepth: 4, useHold: true },
  ruthless: { weights: DELLACHERIE, reactionTicks: 1, mistakeRate: 0, mistakeDepth: 1, useHold: true },
};

export const DIFFICULTY_ORDER: readonly Difficulty[] = ['rookie', 'steady', 'sharp', 'ruthless'];

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTY_ORDER as readonly string[]).includes(value);
}

const NOTHING: readonly ActionName[] = [];

/**
 * A bot playing one seat.
 *
 * Stateful only in the sense that it remembers the plan it is part-way through
 * typing. Re-planning happens whenever the plan runs out or the piece it was
 * for is gone.
 */
export class Bot {
  private plan: ActionName[] = [];
  private cooldown = 0;
  /** Signature of the piece the current plan was made for. */
  private planFor = '';
  private lastChoice: Placement | null = null;
  private searchCount = 0;

  constructor(
    readonly seat: PlayerId,
    private config: BotConfig = DIFFICULTIES.steady,
  ) {}

  setDifficulty(difficulty: Difficulty): void {
    this.config = DIFFICULTIES[difficulty];
    this.reset();
  }

  setConfig(config: BotConfig): void {
    this.config = config;
    this.reset();
  }

  /** Forget the current plan — call when a new match starts. */
  reset(): void {
    this.plan = [];
    this.cooldown = 0;
    this.planFor = '';
    this.lastChoice = null;
    this.searchCount = 0;
  }

  /** The placement the bot is currently working towards, for debugging. */
  get intent(): Placement | null {
    return this.lastChoice;
  }

  /**
   * How many placement searches this bot has run.
   *
   * The cost of the bot is one search per piece, not one per tick — that is the
   * property that keeps it affordable inside the client's frame budget, and
   * unlike a stopwatch it is the same number on every machine.
   */
  get searches(): number {
    return this.searchCount;
  }

  /**
   * One tick of thinking. Always returns a valid `PlayerInput`, including an
   * empty one — the caller can hand it straight to `step()`.
   */
  think(state: MatchState): PlayerInput {
    const frame = state.frame;
    const player = state.players[this.seat];

    if (state.status !== 'playing' || !player.alive || !player.active) {
      // Between pieces there is nothing to aim at, and the plan that got us
      // here is spent.
      this.plan = [];
      this.planFor = '';
      return { frame, pressed: [...NOTHING], held: [...NOTHING] };
    }

    const signature = `${player.bagIndex}:${player.active.type}:${player.hold ?? '-'}:${player.holdUsed ? 1 : 0}`;
    if (this.plan.length === 0 || this.planFor !== signature) {
      this.plan = this.makePlan(state);
      this.planFor = signature;
    }

    if (this.cooldown > 0) {
      this.cooldown--;
      return { frame, pressed: [...NOTHING], held: [...NOTHING] };
    }

    const action = this.plan.shift();
    if (!action) return { frame, pressed: [...NOTHING], held: [...NOTHING] };
    this.cooldown = Math.max(0, this.config.reactionTicks - 1);
    // The action goes in BOTH lists, because that is what a keyboard does: on
    // the frame you press a key it is simultaneously a fresh press and a held
    // key. The simulation derives its movement direction from `held` and only
    // uses `pressed` to tell a tap from auto-repeat, so an action sent as
    // `pressed` alone is read as "no direction" and silently does nothing —
    // which is exactly how this bot spent its first version stacking every
    // piece into one column.
    return { frame, pressed: [action], held: [action] };
  }

  private makePlan(state: MatchState): ActionName[] {
    const player = state.players[this.seat];
    const active = player.active;
    if (!active) return [];

    // What a hold press would actually produce: the stored piece, or the next
    // one out of the bag if nothing is held yet.
    const holdCandidate = player.holdUsed
      ? null
      : player.hold ?? nextPieces(state.seed, player.bagIndex, 1)[0] ?? null;

    this.searchCount++;
    const ranked = rankPlacements(player.board, active.type, holdCandidate, {
      weights: this.config.weights,
      useHold: this.config.useHold,
    });
    if (ranked.length === 0) return ['hardDrop'];

    const choice = this.pick(ranked, state);
    this.lastChoice = choice;
    return [...choice.actions];
  }

  /**
   * Best placement, or a deliberately worse one.
   *
   * The roll is seeded from the match seed and the frame, so a bot match is as
   * reproducible as a human one — run it twice and the same mistakes happen in
   * the same places.
   */
  private pick(ranked: Placement[], state: MatchState): Placement {
    const best = ranked[0]!;
    if (this.config.mistakeRate <= 0 || ranked.length === 1) return best;

    let roll = xorshift32((state.seed ^ (state.frame * 2654435761)) >>> 0 || 1);
    if ((roll % 10_000) / 10_000 >= this.config.mistakeRate) return best;

    roll = xorshift32(roll);
    const depth = Math.min(this.config.mistakeDepth, ranked.length - 1);
    if (depth <= 0) return best;
    return ranked[1 + (roll % depth)] ?? best;
  }
}

/**
 * Convenience for a solo/versus loop: builds the `Inputs` pair with the bot in
 * one seat and the human's input in the other.
 */
export function botInputs(bot: Bot, state: MatchState, human: PlayerInput): [PlayerInput, PlayerInput] {
  const thought = bot.think(state);
  return bot.seat === 0 ? [thought, human] : [human, thought];
}

/**
 * @tetrisvs/store — persistence for the authoritative server.
 *
 * SQLite in WAL mode, embedded in the game server process: no daemon, no
 * credentials, no network hop between the match ending and the row landing.
 *
 * The one thing to keep in mind when using this package: `better-sqlite3` is
 * synchronous, so every call here blocks the event loop for its duration. That
 * is fine — and fast — for the reads an HTTP handler does, and it is why match
 * writes go through `Store.recordMatch()`, which only enqueues.
 */

import { closeDatabase, maintain, migrate, openDatabase, schemaVersion, type Db, type StoreOptions } from './db.js';
import { MatchStore, type MatchRecord } from './matches.js';
import { PlayerStore } from './players.js';
import { WriteQueue, type QueueStats } from './queue.js';

export { openDatabase, closeDatabase, migrate, maintain, schemaVersion };
export type { Db, StoreOptions };

export { MIGRATIONS, type Migration } from './migrations.js';

export {
  DEFAULT_PARAMS,
  dummyVerify,
  hashPassword,
  needsRehash,
  parseParams,
  serializeParams,
  verifyPassword,
  type ScryptParams,
  type StoredPassword,
} from './passwords.js';

export {
  PASSWORD_MAX,
  PASSWORD_MIN,
  PlayerStore,
  SESSION_TTL_MS,
  USERNAME_MAX,
  USERNAME_MIN,
  normalizeUsername,
  passwordAcceptable,
  type AuthFailure,
  type AuthResult,
  type Player,
} from './players.js';

export {
  ELO_K,
  MatchStore,
  STARTING_RATING,
  dayKey,
  expectedScore,
  ratingDelta,
  type DailyStats,
  type EndReason,
  type LeaderboardRow,
  type MatchMode,
  type MatchRecord,
  type MatchSide,
  type MatchSummary,
} from './matches.js';

export { WriteQueue, type QueueOptions, type QueueStats } from './queue.js';

export interface TetrisStoreOptions extends StoreOptions {
  /** How often queued matches are written. */
  flushIntervalMs?: number;
  /** How often expired sessions and stale rate-limit rows are swept. */
  pruneIntervalMs?: number;
  onError?: (scope: string, error: unknown) => void;
}

/**
 * Everything wired together: one database, the two repositories, the deferred
 * write queue, and the housekeeping timers.
 */
export class TetrisStore {
  readonly db: Db;
  readonly players: PlayerStore;
  readonly matches: MatchStore;

  private readonly queue: WriteQueue<MatchRecord>;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pruneIntervalMs: number;
  private readonly onError?: (scope: string, error: unknown) => void;
  private closed = false;

  constructor(options: TetrisStoreOptions) {
    this.onError = options.onError;
    this.db = openDatabase(options);
    this.players = new PlayerStore(this.db);
    this.matches = new MatchStore(this.db);
    this.pruneIntervalMs = options.pruneIntervalMs ?? 10 * 60 * 1000;

    this.queue = new WriteQueue<MatchRecord>({
      flush: (batch) => this.matches.recordMany(batch),
      intervalMs: options.flushIntervalMs ?? 250,
      onError: (error, batch) => this.onError?.(`match-write x${batch.length}`, error),
      onDrop: (dropped) => this.onError?.('match-queue-overflow', new Error(`dropped ${dropped} match records`)),
    });
  }

  /** Start the background timers. Safe to call once. */
  start(): void {
    this.queue.start();
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      try {
        this.players.prune();
        maintain(this.db);
      } catch (error) {
        this.onError?.('prune', error);
      }
    }, this.pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  /**
   * Queue a finished match. Returns immediately — this is the call the 60 Hz
   * loop makes, so it must never touch the disk.
   */
  recordMatch(record: MatchRecord): void {
    this.queue.push(record);
  }

  /** Write anything queued right now. Returns rows written. */
  flush(): number {
    return this.queue.drain();
  }

  queueStats(): QueueStats {
    return this.queue.stats();
  }

  /** Flush, stop the timers, checkpoint, and close. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.stop();
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    closeDatabase(this.db);
  }
}

/**
 * Database handle: connection settings and schema migration.
 *
 * The whole point of choosing SQLite here is that the game server keeps its
 * data in the same process — no socket, no daemon, no credentials. The price is
 * that `better-sqlite3` is **synchronous**: every query blocks the event loop,
 * and this process also runs a 60 Hz simulation with a 16.7 ms budget per tick.
 *
 * Two rules follow from that, and everything else in this package exists to
 * keep them:
 *   1. never touch the database from the tick path — queue the write instead
 *      (see `WriteQueue`)
 *   2. every statement is prepared once and reused; every multi-row change runs
 *      inside one transaction
 */

import Database, { type Database as Db } from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export type { Db };

export interface StoreOptions {
  /** Database file, or `':memory:'` for tests. */
  file: string;
  /** How long a writer will wait on a lock before giving up. */
  busyTimeoutMs?: number;
  /** Page-cache size in MiB. */
  cacheMiB?: number;
  /** Set for a read-only replica/analytics connection. */
  readonly?: boolean;
  /** Called once per applied migration; handy for startup logs. */
  onMigrate?: (from: number, to: number) => void;
}

const DEFAULTS = {
  busyTimeoutMs: 5_000,
  cacheMiB: 16,
};

/**
 * Open (creating if needed) and bring the schema up to date.
 *
 * `journal_mode = WAL` is the one pragma stored in the file itself; the rest are
 * per-connection and must be set on every handle.
 */
export function openDatabase(options: StoreOptions): Db {
  const db = new Database(options.file, { readonly: options.readonly === true });

  // Readers never block the writer and the writer never blocks readers. For a
  // game server answering leaderboard queries while a match is being recorded,
  // this is the difference between "fast" and "occasionally frozen".
  if (!options.readonly) db.pragma('journal_mode = WAL');

  // NORMAL is the documented-safe setting under WAL: a crash cannot corrupt the
  // database, at worst the last transaction or two is lost. FULL fsyncs on every
  // commit and costs roughly an order of magnitude.
  db.pragma('synchronous = NORMAL');

  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULTS.busyTimeoutMs}`);
  db.pragma('temp_store = MEMORY');
  db.pragma(`cache_size = ${-(options.cacheMiB ?? DEFAULTS.cacheMiB) * 1024}`);
  // Keep the WAL from growing without bound on a long-running server.
  db.pragma('wal_autocheckpoint = 1000');

  if (!options.readonly) migrate(db, options.onMigrate);
  return db;
}

/** Current schema version recorded in the file. */
export function schemaVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }));
}

/**
 * Apply every migration the file has not seen yet.
 *
 * Each step runs in its own transaction and bumps `user_version`, so an
 * interrupted upgrade leaves the file at a version that actually exists rather
 * than half-way through one.
 */
export function migrate(db: Db, onMigrate?: (from: number, to: number) => void): number {
  let version = schemaVersion(db);
  for (let index = version; index < MIGRATIONS.length; index++) {
    const migration = MIGRATIONS[index]!;
    const from = index;
    const to = index + 1;
    db.transaction(() => {
      migration(db);
      db.pragma(`user_version = ${to}`);
    })();
    onMigrate?.(from, to);
    version = to;
  }
  return version;
}

/**
 * Housekeeping. Cheap, and worth running on a timer rather than never:
 * `optimize` refreshes the query planner's statistics as tables grow, and the
 * checkpoint keeps the WAL from becoming the largest file on disk.
 */
export function maintain(db: Db): void {
  db.pragma('wal_checkpoint(PASSIVE)');
  db.pragma('optimize');
}

/** Flush the WAL and close cleanly. Safe to call twice. */
export function closeDatabase(db: Db): void {
  if (!db.open) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* a read-only or already-detached handle is nothing to fail on */
  }
  db.close();
}

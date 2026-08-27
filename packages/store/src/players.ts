/**
 * Accounts, sessions, and the rate limiting that keeps them from being a
 * brute-force target.
 *
 * Everything a client sends arrives here already parsed but not trusted:
 * usernames are validated against a whitelist rather than an escape list, and
 * every statement is prepared with bound parameters, so no caller can reach the
 * SQL text.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database as Db, Statement } from 'better-sqlite3';
import { DEFAULT_PARAMS, dummyVerify, hashPassword, needsRehash, verifyPassword, type ScryptParams, type StoredPassword } from './passwords.js';

// ---------------------------------------------------------------- policy

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
/** Whitelist, not a blocklist: anything not listed cannot appear in a name. */
const USERNAME_RE = /^[A-Za-z0-9_-]+$/;

export const PASSWORD_MIN = 8;
/** scrypt over a 10 MB "password" is a free way to pin a core. */
export const PASSWORD_MAX = 200;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Failed sign-ins tolerated per account, then per source address. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_USER = 10;
const MAX_FAILURES_PER_SOURCE = 30;
const MAX_REGISTRATIONS_PER_SOURCE = 5;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

const TOKEN_BYTES = 32;

// ---------------------------------------------------------------- types

export interface Player {
  id: number;
  username: string;
  createdAt: number;
  lastSeenAt: number | null;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  lines: number;
  attack: number;
  bestAttack: number;
  rating: number;
}

export type AuthFailure =
  | 'username-invalid'
  | 'username-taken'
  | 'password-weak'
  | 'credentials'
  | 'banned'
  | 'rate-limited';

export type AuthResult =
  | { ok: true; player: Player; token: string; expiresAt: number }
  | { ok: false; reason: AuthFailure; retryAfterMs?: number; message: string };

interface PlayerRow {
  id: number;
  username: string;
  username_fold: string;
  password_hash: Buffer;
  password_salt: Buffer;
  password_params: string;
  created_at: number;
  last_seen_at: number | null;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  lines: number;
  attack: number;
  best_attack: number;
  rating: number;
  banned_at?: number | null;
  ban_reason?: string | null;
}

function toPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    matches: row.matches,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    lines: row.lines,
    attack: row.attack,
    bestAttack: row.best_attack,
    rating: row.rating,
  };
}

// ---------------------------------------------------------------- validation

export function normalizeUsername(raw: unknown): { username: string; fold: string } | null {
  if (typeof raw !== 'string') return null;
  const username = raw.trim();
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) return null;
  if (!USERNAME_RE.test(username)) return null;
  // Fold with a fixed locale rule. `toLowerCase()` is locale-independent in JS,
  // but the whitelist above already excludes the characters where case folding
  // differs between locales.
  return { username, fold: username.toLowerCase() };
}

export function passwordAcceptable(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= PASSWORD_MIN && raw.length <= PASSWORD_MAX;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

// ---------------------------------------------------------------- store

export interface PlayerStoreOptions {
  /**
   * scrypt cost for new hashes and for the decoy verification an unknown
   * username triggers.
   *
   * Configurable because the right number depends on the box: the default
   * spends ~90 ms and 32 MiB per attempt, which is the point, but it also means
   * the rate limiter is what bounds how much work a stranger can make the
   * server do. Tests lower it so a suite that exercises the lockout does not
   * spend three seconds proving scrypt is slow.
   */
  params?: ScryptParams;
}

export class PlayerStore {
  private readonly params: ScryptParams;
  private readonly insertPlayer: Statement;
  private readonly byFold: Statement;
  private readonly byIdStmt: Statement;
  private readonly updatePassword: Statement;
  private readonly touchStmt: Statement;

  private readonly insertSession: Statement;
  private readonly sessionByHash: Statement;
  private readonly touchSession: Statement;
  private readonly deleteSession: Statement;
  private readonly deletePlayerSessions: Statement;
  private readonly pruneSessions: Statement;

  private readonly recordAttempt: Statement;
  private readonly failuresForUser: Statement;
  private readonly failuresForSource: Statement;
  private readonly registrationsForSource: Statement;
  private readonly pruneAttempts: Statement;

  constructor(private readonly db: Db, options: PlayerStoreOptions = {}) {
    this.params = options.params ?? DEFAULT_PARAMS;
    this.insertPlayer = db.prepare(`
      INSERT INTO players (username, username_fold, password_hash, password_salt, password_params, created_at)
      VALUES (@username, @fold, @hash, @salt, @params, @now)
    `);
    this.byFold = db.prepare('SELECT * FROM players WHERE username_fold = ?');
    this.byIdStmt = db.prepare('SELECT * FROM players WHERE id = ?');
    this.updatePassword = db.prepare(`
      UPDATE players SET password_hash = @hash, password_salt = @salt, password_params = @params WHERE id = @id
    `);
    this.touchStmt = db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?');

    this.insertSession = db.prepare(`
      INSERT INTO sessions (token_hash, player_id, created_at, expires_at, last_used_at)
      VALUES (@hash, @player, @now, @expires, @now)
    `);
    this.sessionByHash = db.prepare(`
      SELECT s.token_hash, s.player_id, s.expires_at, p.*
      FROM sessions s JOIN players p ON p.id = s.player_id
      WHERE s.token_hash = ?
    `);
    this.touchSession = db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?');
    this.deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
    this.deletePlayerSessions = db.prepare('DELETE FROM sessions WHERE player_id = ?');
    this.pruneSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

    this.recordAttempt = db.prepare(`
      INSERT INTO login_attempts (username_fold, source, at, ok) VALUES (?, ?, ?, ?)
    `);
    this.failuresForUser = db.prepare(`
      SELECT COUNT(*) n FROM login_attempts WHERE username_fold = ? AND ok = 0 AND at > ?
    `);
    this.failuresForSource = db.prepare(`
      SELECT COUNT(*) n FROM login_attempts WHERE source = ? AND ok = 0 AND at > ?
    `);
    this.registrationsForSource = db.prepare(`
      SELECT COUNT(*) n FROM login_attempts WHERE source = ? AND ok = 2 AND at > ?
    `);
    this.pruneAttempts = db.prepare('DELETE FROM login_attempts WHERE at <= ?');
  }

  // -------------------------------------------------------------- reads

  byId(id: number): Player | null {
    const row = this.byIdStmt.get(id) as PlayerRow | undefined;
    return row ? toPlayer(row) : null;
  }

  byUsername(raw: string): Player | null {
    const normalized = normalizeUsername(raw);
    if (!normalized) return null;
    const row = this.byFold.get(normalized.fold) as PlayerRow | undefined;
    return row ? toPlayer(row) : null;
  }

  // -------------------------------------------------------------- register

  async register(rawUsername: unknown, rawPassword: unknown, source = 'unknown', now = Date.now()): Promise<AuthResult> {
    const normalized = normalizeUsername(rawUsername);
    if (!normalized) {
      return {
        ok: false,
        reason: 'username-invalid',
        message: `Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters, letters, digits, "-" or "_".`,
      };
    }
    if (!passwordAcceptable(rawPassword)) {
      return { ok: false, reason: 'password-weak', message: `Password must be at least ${PASSWORD_MIN} characters.` };
    }

    const since = now - REGISTER_WINDOW_MS;
    const used = (this.registrationsForSource.get(source, since) as { n: number }).n;
    if (used >= MAX_REGISTRATIONS_PER_SOURCE) {
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: REGISTER_WINDOW_MS,
        message: 'Too many accounts created from here. Try again later.',
      };
    }

    // Check first for a friendly message, but the UNIQUE index is what actually
    // decides — two simultaneous registrations must not both succeed.
    if (this.byFold.get(normalized.fold)) {
      return { ok: false, reason: 'username-taken', message: 'That name is taken.' };
    }

    const stored = await hashPassword(rawPassword, this.params);

    let id: number;
    try {
      const result = this.insertPlayer.run({
        username: normalized.username,
        fold: normalized.fold,
        hash: stored.hash,
        salt: stored.salt,
        params: stored.params,
        now,
      });
      id = Number(result.lastInsertRowid);
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return { ok: false, reason: 'username-taken', message: 'That name is taken.' };
      }
      throw error;
    }

    // `ok = 2` marks a registration, so it can be counted separately from logins.
    this.recordAttempt.run(normalized.fold, source, now, 2);
    const player = this.byId(id)!;
    return { ok: true, player, ...this.issue(player.id, now) };
  }

  // -------------------------------------------------------------- login

  async login(rawUsername: unknown, rawPassword: unknown, source = 'unknown', now = Date.now()): Promise<AuthResult> {
    const normalized = normalizeUsername(rawUsername);
    const password = typeof rawPassword === 'string' ? rawPassword : '';
    const since = now - LOGIN_WINDOW_MS;

    const sourceFailures = (this.failuresForSource.get(source, since) as { n: number }).n;
    if (sourceFailures >= MAX_FAILURES_PER_SOURCE) {
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: LOGIN_WINDOW_MS,
        message: 'Too many failed sign-ins from here. Try again later.',
      };
    }

    if (normalized) {
      const userFailures = (this.failuresForUser.get(normalized.fold, since) as { n: number }).n;
      if (userFailures >= MAX_FAILURES_PER_USER) {
        return {
          ok: false,
          reason: 'rate-limited',
          retryAfterMs: LOGIN_WINDOW_MS,
          message: 'Too many failed sign-ins for this account. Try again later.',
        };
      }
    }

    const row = normalized ? (this.byFold.get(normalized.fold) as PlayerRow | undefined) : undefined;

    // No such user still costs a full scrypt, so response time cannot be used to
    // enumerate accounts.
    if (!row) {
      await dummyVerify(password || 'x', this.params);
      this.recordAttempt.run(normalized?.fold ?? null, source, now, 0);
      return { ok: false, reason: 'credentials', message: 'Wrong name or password.' };
    }

    const stored: StoredPassword = {
      hash: row.password_hash,
      salt: row.password_salt,
      params: row.password_params,
    };
    const valid = passwordAcceptable(password) && (await verifyPassword(password, stored));
    if (!valid) {
      this.recordAttempt.run(row.username_fold, source, now, 0);
      return { ok: false, reason: 'credentials', message: 'Wrong name or password.' };
    }

    // Checked after the password so a ban cannot be probed without credentials.
    if (row.banned_at != null) {
      this.recordAttempt.run(row.username_fold, source, now, 0);
      return {
        ok: false,
        reason: 'banned',
        message: row.ban_reason ? `This account is suspended: ${row.ban_reason}` : 'This account is suspended.',
      };
    }

    // Successful login is the one moment we hold the plaintext, so it is the
    // only chance to transparently upgrade an old hash.
    if (needsRehash(stored, this.params)) {
      const upgraded = await hashPassword(password, this.params);
      this.updatePassword.run({ id: row.id, hash: upgraded.hash, salt: upgraded.salt, params: upgraded.params });
    }

    this.recordAttempt.run(row.username_fold, source, now, 1);
    this.touchStmt.run(now, row.id);
    return { ok: true, player: this.byId(row.id)!, ...this.issue(row.id, now) };
  }

  // -------------------------------------------------------------- sessions

  /** Mint a session. The raw token is returned once and never stored. */
  private issue(playerId: number, now: number): { token: string; expiresAt: number } {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = now + SESSION_TTL_MS;
    this.insertSession.run({ hash: hashToken(token), player: playerId, now, expires: expiresAt });
    return { token, expiresAt };
  }

  /** Resolve a bearer token, or `null` if it is unknown, expired, or malformed. */
  resolveSession(token: unknown, now = Date.now()): Player | null {
    if (typeof token !== 'string' || token.length < 16 || token.length > 512) return null;
    const digest = hashToken(token);
    const row = this.sessionByHash.get(digest) as (PlayerRow & { token_hash: Buffer; expires_at: number }) | undefined;
    if (!row) return null;
    // Belt and braces: the lookup was by primary key, but compare in constant
    // time anyway so this stays safe if the lookup is ever widened.
    if (row.token_hash.length !== digest.length || !timingSafeEqual(row.token_hash, digest)) return null;
    if (row.expires_at <= now) {
      this.deleteSession.run(digest);
      return null;
    }
    // Banning drops sessions, but a token minted in the same instant would
    // otherwise survive. Refuse it here too.
    if (row.banned_at != null) {
      this.deleteSession.run(digest);
      return null;
    }
    this.touchSession.run(now, digest);
    return toPlayer(row);
  }

  logout(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    return this.deleteSession.run(hashToken(token)).changes > 0;
  }

  /** Invalidate every session for a player — the "sign out everywhere" button. */
  logoutAll(playerId: number): number {
    return this.deletePlayerSessions.run(playerId).changes;
  }

  touch(playerId: number, now = Date.now()): void {
    this.touchStmt.run(now, playerId);
  }

  /** Drop expired sessions and stale rate-limit rows. Cheap; run on a timer. */
  prune(now = Date.now()): { sessions: number; attempts: number } {
    const sessions = this.pruneSessions.run(now).changes;
    const attempts = this.pruneAttempts.run(now - Math.max(LOGIN_WINDOW_MS, REGISTER_WINDOW_MS)).changes;
    return { sessions, attempts };
  }
}

/**
 * Operator accounts, bans, and the audit trail behind the admin console.
 *
 * The single most important thing in this file is `isAdmin`. A guard that only
 * asks "is there a bearer token?" is not a guard — any signed-in player would
 * pass it, which is exactly how an admin surface becomes a privilege-escalation
 * bug. Every admin route resolves the session **and** checks the role.
 *
 * First-admin bootstrap follows the pattern that worked before: the promotion
 * is only permitted while zero admins exist, and the check plus the write
 * happen inside one transaction so two simultaneous requests cannot both win.
 */

import type { Database as Db, Statement } from 'better-sqlite3';
import type { Player } from './players.js';

export type Role = 'player' | 'admin' | 'owner';

export const ROLES: readonly Role[] = ['player', 'admin', 'owner'];

export interface AdminPlayer extends Player {
  role: Role;
  bannedAt: number | null;
  banReason: string | null;
}

export interface AuditEntry {
  id: number;
  at: number;
  actorId: number | null;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

export type SetupResult =
  | { ok: true; player: AdminPlayer }
  | { ok: false; reason: 'already-set-up' | 'no-such-player' };

interface AdminRow {
  id: number;
  username: string;
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
  role: Role;
  banned_at: number | null;
  ban_reason: string | null;
}

function toAdminPlayer(row: AdminRow): AdminPlayer {
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
    role: row.role,
    bannedAt: row.banned_at,
    banReason: row.ban_reason,
  };
}

const PLAYER_COLUMNS = `
  id, username, created_at, last_seen_at, matches, wins, losses, draws,
  lines, attack, best_attack, rating, role, banned_at, ban_reason
`;

export class AdminStore {
  private readonly countAdmins: Statement;
  private readonly byId: Statement;
  private readonly byFold: Statement;
  private readonly setRole: Statement;
  private readonly setBan: Statement;
  private readonly listPlayers: Statement;
  private readonly searchPlayers: Statement;
  private readonly listStaff: Statement;
  private readonly insertAudit: Statement;
  private readonly recentAudit: Statement;
  private readonly dropSessions: Statement;

  private readonly bootstrap: (playerId: number, actor: string) => SetupResult;

  constructor(private readonly db: Db) {
    this.countAdmins = db.prepare("SELECT COUNT(*) n FROM players WHERE role IN ('admin','owner')");
    this.byId = db.prepare(`SELECT ${PLAYER_COLUMNS} FROM players WHERE id = ?`);
    this.byFold = db.prepare(`SELECT ${PLAYER_COLUMNS} FROM players WHERE username_fold = ?`);
    this.setRole = db.prepare('UPDATE players SET role = ? WHERE id = ?');
    this.setBan = db.prepare('UPDATE players SET banned_at = ?, ban_reason = ? WHERE id = ?');
    this.listPlayers = db.prepare(`SELECT ${PLAYER_COLUMNS} FROM players ORDER BY last_seen_at DESC NULLS LAST, id DESC LIMIT ?`);
    this.searchPlayers = db.prepare(`
      SELECT ${PLAYER_COLUMNS} FROM players
      WHERE username_fold LIKE ? ESCAPE '\\'
      ORDER BY last_seen_at DESC NULLS LAST, id DESC LIMIT ?
    `);
    this.listStaff = db.prepare(`SELECT ${PLAYER_COLUMNS} FROM players WHERE role <> 'player' ORDER BY role DESC, id ASC`);
    this.insertAudit = db.prepare(`
      INSERT INTO admin_audit (at, actor_id, actor, action, target, detail)
      VALUES (@at, @actorId, @actor, @action, @target, @detail)
    `);
    this.recentAudit = db.prepare('SELECT * FROM admin_audit ORDER BY at DESC, id DESC LIMIT ?');
    this.dropSessions = db.prepare('DELETE FROM sessions WHERE player_id = ?');

    // Check-and-write in one transaction: two setup requests arriving together
    // must not both find "zero admins" and both succeed.
    this.bootstrap = db.transaction((playerId: number, actor: string): SetupResult => {
      if ((this.countAdmins.get() as { n: number }).n > 0) return { ok: false, reason: 'already-set-up' };
      const row = this.byId.get(playerId) as AdminRow | undefined;
      if (!row) return { ok: false, reason: 'no-such-player' };
      this.setRole.run('owner', playerId);
      this.writeAudit({ actorId: playerId, actor, action: 'setup:first-owner', target: row.username, detail: null });
      return { ok: true, player: toAdminPlayer(this.byId.get(playerId) as AdminRow) };
    });
  }

  // -------------------------------------------------------------- roles

  /** True only for a real operator role — never merely "has a session". */
  isAdmin(player: { id: number } | null | undefined): boolean {
    if (!player) return false;
    const row = this.byId.get(player.id) as AdminRow | undefined;
    return row?.role === 'admin' || row?.role === 'owner';
  }

  roleOf(playerId: number): Role | null {
    return (this.byId.get(playerId) as AdminRow | undefined)?.role ?? null;
  }

  get adminCount(): number {
    return (this.countAdmins.get() as { n: number }).n;
  }

  /** True while nobody is an operator yet — the console shows its setup screen. */
  needsSetup(): boolean {
    return this.adminCount === 0;
  }

  /** Promote the first owner. Only possible while no operator exists. */
  claimFirstOwner(playerId: number, actor: string): SetupResult {
    return this.bootstrap(playerId, actor);
  }

  /**
   * Change someone's role.
   *
   * Refuses to remove the last operator, and refuses to let an operator demote
   * themselves — both of which end with a console nobody can sign into.
   */
  assignRole(actor: AdminPlayer, targetId: number, role: Role): { ok: true; player: AdminPlayer } | { ok: false; reason: string } {
    if (!ROLES.includes(role)) return { ok: false, reason: 'Unknown role' };
    const target = this.byId.get(targetId) as AdminRow | undefined;
    if (!target) return { ok: false, reason: 'No such player' };
    if (target.role === 'owner' && actor.role !== 'owner') return { ok: false, reason: 'Only an owner can change an owner' };
    if (target.id === actor.id && role === 'player') return { ok: false, reason: 'You cannot demote yourself' };
    if (role === 'player' && target.role !== 'player' && this.adminCount <= 1) {
      return { ok: false, reason: 'That is the last operator' };
    }

    this.setRole.run(role, targetId);
    this.writeAudit({ actorId: actor.id, actor: actor.username, action: `role:${role}`, target: target.username, detail: `was ${target.role}` });
    return { ok: true, player: toAdminPlayer(this.byId.get(targetId) as AdminRow) };
  }

  // -------------------------------------------------------------- bans

  /**
   * Ban a player and drop every session they hold, so the ban takes effect on
   * the next request rather than whenever their token happens to expire.
   */
  ban(actor: AdminPlayer, targetId: number, reason: string, now = Date.now()): { ok: true; player: AdminPlayer } | { ok: false; reason: string } {
    const target = this.byId.get(targetId) as AdminRow | undefined;
    if (!target) return { ok: false, reason: 'No such player' };
    if (target.id === actor.id) return { ok: false, reason: 'You cannot ban yourself' };
    if (target.role !== 'player' && actor.role !== 'owner') return { ok: false, reason: 'Only an owner can ban an operator' };

    const trimmed = typeof reason === 'string' ? reason.slice(0, 200) : '';
    this.db.transaction(() => {
      this.setBan.run(now, trimmed || null, targetId);
      this.dropSessions.run(targetId);
    })();
    this.writeAudit({ actorId: actor.id, actor: actor.username, action: 'ban', target: target.username, detail: trimmed || null });
    return { ok: true, player: toAdminPlayer(this.byId.get(targetId) as AdminRow) };
  }

  unban(actor: AdminPlayer, targetId: number): { ok: true; player: AdminPlayer } | { ok: false; reason: string } {
    const target = this.byId.get(targetId) as AdminRow | undefined;
    if (!target) return { ok: false, reason: 'No such player' };
    this.setBan.run(null, null, targetId);
    this.writeAudit({ actorId: actor.id, actor: actor.username, action: 'unban', target: target.username, detail: null });
    return { ok: true, player: toAdminPlayer(this.byId.get(targetId) as AdminRow) };
  }

  isBanned(playerId: number): boolean {
    return (this.byId.get(playerId) as AdminRow | undefined)?.banned_at != null;
  }

  // -------------------------------------------------------------- reads

  player(playerId: number): AdminPlayer | null {
    const row = this.byId.get(playerId) as AdminRow | undefined;
    return row ? toAdminPlayer(row) : null;
  }

  playerByUsername(fold: string): AdminPlayer | null {
    const row = this.byFold.get(fold.toLowerCase()) as AdminRow | undefined;
    return row ? toAdminPlayer(row) : null;
  }

  players(limit = 50, query = ''): AdminPlayer[] {
    const capped = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    if (!query.trim()) return (this.listPlayers.all(capped) as AdminRow[]).map(toAdminPlayer);
    // Escape the LIKE wildcards so a search for "%" is a search, not a scan.
    const needle = `%${query.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return (this.searchPlayers.all(needle, capped) as AdminRow[]).map(toAdminPlayer);
  }

  staff(): AdminPlayer[] {
    return (this.listStaff.all() as AdminRow[]).map(toAdminPlayer);
  }

  audit(limit = 50): AuditEntry[] {
    const rows = this.recentAudit.all(Math.max(1, Math.min(200, Math.floor(limit) || 50))) as Array<{
      id: number; at: number; actor_id: number | null; actor: string; action: string; target: string | null; detail: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      actorId: row.actor_id,
      actor: row.actor,
      action: row.action,
      target: row.target,
      detail: row.detail,
    }));
  }

  /** Record an operator action. Called for anything that changes state. */
  writeAudit(entry: { actorId: number | null; actor: string; action: string; target?: string | null; detail?: string | null; at?: number }): void {
    this.insertAudit.run({
      at: entry.at ?? Date.now(),
      actorId: entry.actorId,
      actor: entry.actor.slice(0, 64),
      action: entry.action.slice(0, 64),
      target: entry.target?.slice(0, 64) ?? null,
      detail: entry.detail?.slice(0, 500) ?? null,
    });
  }
}

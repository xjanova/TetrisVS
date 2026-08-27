/**
 * Admin routes.
 *
 * One rule governs this whole file: **`requireOperator` resolves the session
 * and then checks the role.** A guard that only asks "is there a bearer token?"
 * would let any signed-in player run these routes — that is not a smaller bug
 * than having no guard at all, it is the same bug with more confidence.
 *
 * First-owner bootstrap is the other sharp edge. It is permitted only while
 * zero operators exist, and the count-and-promote happens inside a single
 * transaction so two simultaneous requests cannot both find "zero" and win.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminPlayer, TetrisStore } from '@tetrisvs/store';
import type { GameControl } from './control.js';

export interface AdminContext {
  store: TetrisStore;
  control: GameControl;
  address: string;
  bearer: string | null;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  send: (status: number, body: unknown) => void;
}

/** Resolve a caller to an operator, or answer the request and return null. */
function requireOperator(context: AdminContext): AdminPlayer | null {
  const player = context.store.players.resolveSession(context.bearer);
  if (!player) {
    context.send(401, { error: 'Sign in first' });
    return null;
  }
  const operator = context.store.admin.player(player.id);
  if (!operator || (operator.role !== 'admin' && operator.role !== 'owner')) {
    // Same wording either way: a player probing this route learns nothing about
    // whether the account exists or what it would take to pass.
    context.send(403, { error: 'Not an operator' });
    return null;
  }
  return operator;
}

function integer(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function text(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Handle an `/api/admin/*` route. Returns false when the path is not ours.
 */
export async function handleAdmin(path: string, method: string, context: AdminContext): Promise<boolean> {
  const { store, control, send } = context;

  // ---------------------------------------------------------------- setup
  // Deliberately unauthenticated, and deliberately says nothing except whether
  // the console still needs its first owner.
  if (path === '/api/admin/setup-status' && method === 'GET') {
    send(200, { needsSetup: store.admin.needsSetup() });
    return true;
  }

  if (path === '/api/admin/setup' && method === 'POST') {
    const player = store.players.resolveSession(context.bearer);
    if (!player) {
      send(401, { error: 'Sign in as the account you want to make owner, then claim it.' });
      return true;
    }
    const result = store.admin.claimFirstOwner(player.id, player.username);
    if (!result.ok) {
      send(409, {
        error: result.reason === 'already-set-up'
          ? 'An operator already exists. Ask them to grant you a role.'
          : 'No such player.',
      });
      return true;
    }
    send(201, { player: result.player });
    return true;
  }

  if (!path.startsWith('/api/admin/')) return false;

  // Everything past this point is operator-only.
  const operator = requireOperator(context);
  if (!operator) return true;

  // ---------------------------------------------------------------- read
  if (path === '/api/admin/overview' && method === 'GET') {
    send(200, {
      me: { id: operator.id, username: operator.username, role: operator.role },
      server: control.view(),
      queue: store.queueStats(),
      totals: store.matches.totals(),
      today: store.matches.days(1)[0] ?? null,
      recentMatches: store.matches.recent(12),
      leaderboard: store.matches.leaderboard(10),
      staff: store.admin.staff(),
      audit: store.admin.audit(15),
    });
    return true;
  }

  if (path === '/api/admin/players' && method === 'GET') {
    const query = text(context.query.get('q') ?? '', 40);
    send(200, { players: store.admin.players(60, query) });
    return true;
  }

  if (path === '/api/admin/audit' && method === 'GET') {
    send(200, { audit: store.admin.audit(100) });
    return true;
  }

  // ---------------------------------------------------------------- act
  if (method !== 'POST') {
    send(404, { error: 'No such endpoint' });
    return true;
  }
  const body = context.body ?? {};

  if (path === '/api/admin/room/close') {
    const code = text(body.code, 12).toUpperCase();
    const reason = text(body.reason, 120) || 'closed by an operator';
    const closed = control.closeRoom(code, reason);
    if (closed) store.admin.writeAudit({ actorId: operator.id, actor: operator.username, action: 'room:close', target: code, detail: reason });
    send(closed ? 200 : 404, closed ? { ok: true } : { error: 'No such room' });
    return true;
  }

  if (path === '/api/admin/kick') {
    const socketId = text(body.socketId, 40);
    const reason = text(body.reason, 120) || 'disconnected by an operator';
    const kicked = control.kick(socketId, reason);
    if (kicked) store.admin.writeAudit({ actorId: operator.id, actor: operator.username, action: 'kick', target: socketId, detail: reason });
    send(kicked ? 200 : 404, kicked ? { ok: true } : { error: 'No such connection' });
    return true;
  }

  if (path === '/api/admin/maintenance') {
    const on = body.on === true;
    control.setMaintenance(on);
    store.admin.writeAudit({ actorId: operator.id, actor: operator.username, action: on ? 'maintenance:on' : 'maintenance:off', target: null, detail: null });
    send(200, { ok: true, maintenance: on });
    return true;
  }

  if (path === '/api/admin/notice') {
    const notice = text(body.notice, 160).trim();
    control.setNotice(notice || null);
    store.admin.writeAudit({ actorId: operator.id, actor: operator.username, action: 'notice', target: null, detail: notice || '(cleared)' });
    send(200, { ok: true, notice: notice || null });
    return true;
  }

  if (path === '/api/admin/flush') {
    const written = store.flush();
    store.admin.writeAudit({ actorId: operator.id, actor: operator.username, action: 'queue:flush', target: null, detail: `${written} rows` });
    send(200, { ok: true, written });
    return true;
  }

  if (path === '/api/admin/ban') {
    const id = integer(body.playerId);
    if (!id) {
      send(400, { error: 'playerId required' });
      return true;
    }
    const result = store.admin.ban(operator, id, text(body.reason, 200));
    if (!result.ok) {
      send(400, { error: result.reason });
      return true;
    }
    // A ban that leaves the player mid-match is not a ban.
    const dropped = control.disconnectAccount(id, 'account suspended');
    send(200, { ok: true, player: result.player, disconnected: dropped });
    return true;
  }

  if (path === '/api/admin/unban') {
    const id = integer(body.playerId);
    if (!id) {
      send(400, { error: 'playerId required' });
      return true;
    }
    const result = store.admin.unban(operator, id);
    send(result.ok ? 200 : 400, result.ok ? { ok: true, player: result.player } : { error: result.reason });
    return true;
  }

  if (path === '/api/admin/role') {
    const id = integer(body.playerId);
    const role = text(body.role, 10);
    if (!id) {
      send(400, { error: 'playerId required' });
      return true;
    }
    if (role !== 'player' && role !== 'admin' && role !== 'owner') {
      send(400, { error: 'role must be player, admin, or owner' });
      return true;
    }
    // Only an owner may hand out operator roles at all.
    if (operator.role !== 'owner' && role !== 'player') {
      send(403, { error: 'Only an owner can grant a role' });
      return true;
    }
    const result = store.admin.assignRole(operator, id, role);
    send(result.ok ? 200 : 400, result.ok ? { ok: true, player: result.player } : { error: result.reason });
    return true;
  }

  send(404, { error: 'No such endpoint' });
  return true;
}

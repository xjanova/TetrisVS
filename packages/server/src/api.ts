/**
 * HTTP API in front of `@tetrisvs/store`.
 *
 * Deliberately hand-rolled on `node:http` rather than pulling in a framework:
 * this process is a 60 Hz simulation first and a web server second, and the
 * surface here is a dozen routes. Fewer dependencies is also fewer CVEs to
 * track on a box that holds password hashes.
 *
 * Rules every handler follows:
 *   - the request body is capped and parsed defensively; a malformed one is a
 *     400, never an exception that escapes into the game loop
 *   - the client's identity comes from a bearer token resolved against the
 *     database, never from anything the client asserts about itself
 *   - errors sent to the client are generic; the detail goes to the log
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TetrisStore } from '@tetrisvs/store';

/** Bodies are usernames and passwords, not uploads. */
const MAX_BODY_BYTES = 4 * 1024;
const BODY_TIMEOUT_MS = 5_000;

/** Requests per address per window, across every route. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 240;

export interface ApiOptions {
  store: TetrisStore;
  /**
   * Honour `X-Forwarded-For`. Only enable behind a proxy you control: the
   * header is client-supplied, so trusting it anywhere else lets anyone forge
   * the address every rate limit is keyed on.
   */
  trustProxy?: boolean;
  onError?: (scope: string, error: unknown) => void;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class Api {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: ApiOptions) {}

  /** Client address used for rate limiting. */
  addressOf(request: IncomingMessage): string {
    if (this.options.trustProxy) {
      const header = request.headers['x-forwarded-for'];
      const first = Array.isArray(header) ? header[0] : header;
      const candidate = first?.split(',')[0]?.trim();
      if (candidate) return candidate;
    }
    return request.socket.remoteAddress ?? 'unknown';
  }

  private allow(address: string, now: number): boolean {
    const bucket = this.buckets.get(address);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(address, { count: 1, resetAt: now + RATE_WINDOW_MS });
      // Opportunistic sweep so the map cannot grow without bound.
      if (this.buckets.size > 10_000) {
        for (const [key, value] of this.buckets) if (value.resetAt <= now) this.buckets.delete(key);
      }
      return true;
    }
    bucket.count++;
    return bucket.count <= RATE_MAX_REQUESTS;
  }

  /**
   * Returns true when the request was handled. Anything else falls through to
   * Socket.IO / the 404.
   */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://internal');
    const path = url.pathname;
    if (path !== '/health' && !path.startsWith('/api/')) return false;

    cors(response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return true;
    }

    const address = this.addressOf(request);
    if (!this.allow(address, Date.now())) {
      send(response, 429, { error: 'Too many requests' });
      return true;
    }

    try {
      await this.route(request, response, path, url, address);
    } catch (error) {
      this.options.onError?.(`api ${request.method} ${path}`, error);
      if (!response.headersSent) send(response, 500, { error: 'Internal error' });
      else response.end();
    }
    return true;
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    url: URL,
    address: string,
  ): Promise<void> {
    const { store } = this.options;
    const method = request.method ?? 'GET';
    const limit = numberParam(url.searchParams.get('limit'), 20);

    if (path === '/health') {
      send(response, 200, {
        service: 'tetrisvs-authoritative',
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        writeQueue: store.queueStats(),
      });
      return;
    }

    // ---------------------------------------------------------- auth
    if (path === '/api/register' && method === 'POST') {
      const body = await readJson(request, response);
      if (!body) return;
      const result = await store.players.register(body.username, body.password, address);
      if (!result.ok) {
        send(response, result.reason === 'rate-limited' ? 429 : 400, { error: result.message, reason: result.reason });
        return;
      }
      send(response, 201, { token: result.token, expiresAt: result.expiresAt, player: result.player });
      return;
    }

    if (path === '/api/login' && method === 'POST') {
      const body = await readJson(request, response);
      if (!body) return;
      const result = await store.players.login(body.username, body.password, address);
      if (!result.ok) {
        send(response, result.reason === 'rate-limited' ? 429 : 401, { error: result.message, reason: result.reason });
        return;
      }
      send(response, 200, { token: result.token, expiresAt: result.expiresAt, player: result.player });
      return;
    }

    if (path === '/api/logout' && method === 'POST') {
      send(response, 200, { ok: store.players.logout(bearer(request)) });
      return;
    }

    if (path === '/api/me' && method === 'GET') {
      const player = store.players.resolveSession(bearer(request));
      if (!player) {
        send(response, 401, { error: 'Sign in first' });
        return;
      }
      send(response, 200, { player, matches: store.matches.forPlayer(player.id, limit) });
      return;
    }

    // ---------------------------------------------------------- public reads
    if (path === '/api/leaderboard' && method === 'GET') {
      send(response, 200, { leaderboard: store.matches.leaderboard(limit) });
      return;
    }

    if (path === '/api/matches' && method === 'GET') {
      send(response, 200, { matches: store.matches.recent(limit) });
      return;
    }

    if (path === '/api/stats' && method === 'GET') {
      // Aggregate only — nothing here identifies a player.
      send(response, 200, { totals: store.matches.totals(), days: store.matches.days(limit) });
      return;
    }

    const replayMatch = /^\/api\/matches\/(\d+)\/replay$/.exec(path);
    if (replayMatch && method === 'GET') {
      const replay = store.matches.replay(Number(replayMatch[1]));
      if (!replay) {
        send(response, 404, { error: 'No replay for that match' });
        return;
      }
      const summary = store.matches.byId(Number(replayMatch[1]));
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(replay.bytes.length),
        'x-replay-version': String(replay.version),
        'x-replay-ticks': String(replay.ticks),
        'x-match-seed': String(summary?.seed ?? 0),
        'cache-control': 'public, max-age=31536000, immutable',
      });
      response.end(Buffer.from(replay.bytes));
      return;
    }

    const matchDetail = /^\/api\/matches\/(\d+)$/.exec(path);
    if (matchDetail && method === 'GET') {
      const summary = store.matches.byId(Number(matchDetail[1]));
      if (!summary) {
        send(response, 404, { error: 'No such match' });
        return;
      }
      send(response, 200, { match: summary });
      return;
    }

    const playerDetail = /^\/api\/players\/([^/]{1,40})$/.exec(path);
    if (playerDetail && method === 'GET') {
      const player = store.players.byUsername(decodeURIComponent(playerDetail[1]!));
      if (!player) {
        send(response, 404, { error: 'No such player' });
        return;
      }
      send(response, 200, { player, matches: store.matches.forPlayer(player.id, limit) });
      return;
    }

    send(response, 404, { error: 'No such endpoint' });
  }
}

// ---------------------------------------------------------------- helpers

function cors(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-max-age', '600');
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    // Account data must never sit in a shared cache.
    'cache-control': 'no-store',
  });
  response.end(payload);
}

export function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * Answer 413 and then hang up.
 *
 * The order matters: destroying the request before the response is flushed
 * leaves the client with a bare connection error and no idea why. Close only
 * once the status is actually on the wire.
 */
function tooLarge(response: ServerResponse): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const payload = JSON.stringify({ error: 'Body too large' });
  response.writeHead(413, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    // The rest of the oversized body is never going to be read.
    connection: 'close',
  });
  response.end(payload, () => response.socket?.destroy());
}

function numberParam(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(200, Math.floor(value)) : fallback;
}

/**
 * Read a small JSON body, answering the request itself on any problem.
 *
 * The size cap matters: without it a client can hold the connection open and
 * stream gigabytes into memory on a process that also has a game to simulate.
 */
async function readJson(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    tooLarge(response);
    return null;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;

  const body = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      request.destroy();
      resolve(null);
    }, BODY_TIMEOUT_MS);

    const finish = (value: string | null) => {
      clearTimeout(timer);
      resolve(value);
    };

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        // Stop buffering, but do not tear the socket down here — the client
        // still has to be able to read the 413 we are about to send.
        request.pause();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => finish(null));
  });

  if (overflowed) {
    tooLarge(response);
    return null;
  }

  if (body === null) {
    if (!response.headersSent) send(response, 400, { error: 'Bad request body' });
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(body || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      send(response, 400, { error: 'Expected a JSON object' });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    send(response, 400, { error: 'Invalid JSON' });
    return null;
  }
}

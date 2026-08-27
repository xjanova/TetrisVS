/**
 * Account + leaderboard client.
 *
 * The token lives in `localStorage` so a player stays signed in between visits,
 * and is sent as a bearer header — never in a URL, where it would end up in
 * proxy logs and browser history.
 */

export interface Player {
  id: number;
  username: string;
  rating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  lines: number;
  attack: number;
  bestAttack: number;
}

export interface LeaderboardRow {
  rank: number;
  id: number;
  username: string;
  rating: number;
  wins: number;
  losses: number;
  lines: number;
  bestAttack: number;
}

export interface MatchSummary {
  id: number;
  winner: 0 | 1 | null;
  reason: 'topout' | 'forfeit';
  endedAt: number;
  frames: number;
  players: Array<{ playerId: number | null; name: string; lines: number; attack: number; ratingDelta: number }>;
}

const TOKEN_KEY = 'tetrisvs.token';

export function serverBase(): string {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  return (configured ?? `${window.location.protocol}//${window.location.hostname}:3001`).replace(/\/$/, '');
}

/** Reading storage throws in some privacy modes; a missing token is not an error. */
export function loadToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* the session still works, it just will not survive a reload */
  }
}

interface ApiResult<T> {
  status: number;
  body: T & { error?: string };
}

async function call<T>(path: string, options: { method?: string; body?: unknown; token?: string | null } = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${serverBase()}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body: body as T & { error?: string } };
}

export interface AuthResponse {
  token: string;
  expiresAt: number;
  player: Player;
}

export function register(username: string, password: string) {
  return call<AuthResponse>('/api/register', { method: 'POST', body: { username, password } });
}

export function login(username: string, password: string) {
  return call<AuthResponse>('/api/login', { method: 'POST', body: { username, password } });
}

export function logout(token: string) {
  return call<{ ok: boolean }>('/api/logout', { method: 'POST', body: {}, token });
}

export function me(token: string) {
  return call<{ player: Player; matches: MatchSummary[] }>('/api/me', { token });
}

export interface ServerStatus {
  online: boolean;
  notice: string | null;
  maintenance: boolean;
  playersOnline: number;
  activeMatches: number;
}

/** Public server state for the menu — no session needed, nobody identified. */
export function status() {
  return call<ServerStatus>('/api/status');
}

export function leaderboard(limit = 10) {
  return call<{ leaderboard: LeaderboardRow[] }>(`/api/leaderboard?limit=${limit}`);
}

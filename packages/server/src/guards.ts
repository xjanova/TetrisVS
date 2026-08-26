/**
 * Input validation for anything that arrives over a socket.
 *
 * Everything a client sends is hostile until proven otherwise: it is trivially
 * forgeable from a browser console. These helpers are pure so they can be
 * unit-tested against the payloads that used to crash the process.
 */

import type { ActionName, PlayerInput } from '@tetrisvs/core';

/** Longest action list a client may send before we stop reading it. */
export const MAX_ACTIONS = 16;

/** Longest room code we will even look at. */
export const MAX_ROOM_CODE = 32;

export const ACTIONS: ReadonlySet<ActionName> = new Set<ActionName>([
  'left', 'right', 'softDrop', 'hardDrop', 'rotCW', 'rotCCW', 'rot180', 'hold',
]);

export interface BufferedInput {
  pressed: ActionName[];
  held: ActionName[];
}

/**
 * Keep only known actions, deduplicated, and never read past `MAX_ACTIONS`.
 * The length cap matters: `filter` over a client-supplied million-element array
 * is a free way to stall the event loop for every other match on the box.
 */
export function safeActions(list: unknown): ActionName[] {
  if (!Array.isArray(list)) return [];
  const out: ActionName[] = [];
  const limit = Math.min(list.length, MAX_ACTIONS);
  for (let i = 0; i < limit; i++) {
    const action = list[i];
    if (typeof action !== 'string') continue;
    if (!ACTIONS.has(action as ActionName)) continue;
    if (out.includes(action as ActionName)) continue;
    out.push(action as ActionName);
  }
  return out;
}

/**
 * Normalise a `match:input` payload, or `null` if it carries nothing usable.
 * Reading `.pressed` off `null` used to throw out of the Socket.IO handler and
 * take the whole server down with it.
 */
export function sanitizeInput(input: unknown): BufferedInput | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<PlayerInput>;
  if (!Array.isArray(raw.pressed) && !Array.isArray(raw.held)) return null;
  return { pressed: safeActions(raw.pressed), held: safeActions(raw.held) };
}

/** `null` when the value could not possibly be a room code. */
export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_ROOM_CODE) return null;
  const code = raw.trim().toUpperCase();
  return /^[0-9A-F]{6}$/.test(code) ? code : null;
}

export interface ReapInput {
  empty: boolean;
  finished: boolean;
  idleMs: number;
}

/** Room lifetime policy, split out so the janitor's rules are testable. */
export function shouldReap({ empty, finished, idleMs }: ReapInput, finishedTtlMs: number, idleTtlMs: number): boolean {
  if (empty) return true;
  if (finished && idleMs > finishedTtlMs) return true;
  return idleMs > idleTtlMs;
}

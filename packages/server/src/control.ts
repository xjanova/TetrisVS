/**
 * The operator's handle on the running game.
 *
 * Kept as an interface so the admin routes never reach into the server's
 * internals directly: everything an operator can do to a live match is listed
 * here, which makes the blast radius of the admin console reviewable in one
 * screen rather than spread across the socket handlers.
 */

import type { PlayerId } from '@tetrisvs/core';

export interface RoomView {
  code: string;
  status: 'countdown' | 'playing' | 'finished';
  frame: number;
  seed: number;
  createdAt: number;
  ageSeconds: number;
  concluded: boolean;
  seats: Array<{
    seat: PlayerId;
    connected: boolean;
    socketId: string | null;
    name: string;
    accountId: number | null;
    alive: boolean;
    lines: number;
    attack: number;
    incoming: number;
  }>;
  replayTicks: number;
}

export interface ConnectionView {
  socketId: string;
  accountId: number | null;
  username: string | null;
  roomCode: string | null;
  seat: PlayerId | null;
  address: string;
  connectedForSeconds: number;
}

export interface ServerView {
  uptimeSeconds: number;
  nodeVersion: string;
  pid: number;
  memoryMB: number;
  rssMB: number;
  tickHz: number;
  /** Simulation steps in the last second — should sit at the tick rate. */
  measuredHz: number;
  rooms: RoomView[];
  connections: ConnectionView[];
  queuedForMatchmaking: number;
  maintenance: boolean;
  notice: string | null;
}

export interface GameControl {
  view(): ServerView;
  /** End a match now. Returns false if there is no such room. */
  closeRoom(code: string, reason: string): boolean;
  /** Disconnect one socket. */
  kick(socketId: string, reason: string): boolean;
  /** Disconnect every socket signed in as this account. Returns how many. */
  disconnectAccount(accountId: number, reason: string): number;
  /** While on, matchmaking and room creation are refused. Live matches finish. */
  setMaintenance(on: boolean): void;
  /** A line of text pushed to every connected client. `null` clears it. */
  setNotice(notice: string | null): void;
}

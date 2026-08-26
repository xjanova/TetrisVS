export interface MatchTicket {
  socketId: string;
  pool: string;
}

export type MatchPair = readonly [MatchTicket, MatchTicket];

/**
 * Synchronous FIFO queue. Node handles each socket event to completion, so the
 * remove-before-return pairing step prevents either socket from being matched
 * twice even when join events arrive in the same event-loop turn.
 */
export class MatchmakingQueue {
  private readonly tickets: MatchTicket[] = [];
  private readonly queuedIds = new Set<string>();

  enqueue(socketId: string, pool = 'default'): MatchPair | null {
    if (this.queuedIds.has(socketId)) return null;
    const opponentIndex = this.tickets.findIndex((ticket) => ticket.pool === pool && ticket.socketId !== socketId);
    if (opponentIndex < 0) {
      this.tickets.push({ socketId, pool });
      this.queuedIds.add(socketId);
      return null;
    }
    const opponent = this.tickets.splice(opponentIndex, 1)[0]!;
    this.queuedIds.delete(opponent.socketId);
    return [opponent, { socketId, pool }];
  }

  remove(socketId: string): boolean {
    if (!this.queuedIds.delete(socketId)) return false;
    const index = this.tickets.findIndex((ticket) => ticket.socketId === socketId);
    if (index >= 0) this.tickets.splice(index, 1);
    return true;
  }

  has(socketId: string): boolean {
    return this.queuedIds.has(socketId);
  }

  get size(): number {
    return this.tickets.length;
  }

  snapshot(): readonly MatchTicket[] {
    return this.tickets.map((ticket) => ({ ...ticket }));
  }
}

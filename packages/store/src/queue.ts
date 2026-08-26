/**
 * Deferred writes.
 *
 * `better-sqlite3` is synchronous, and this process also runs a 60 Hz
 * simulation with 16.7 ms per tick. A write issued from inside the tick is time
 * the simulation spends waiting on a disk — usually invisible, occasionally a
 * visible hitch for both players when the OS decides to flush.
 *
 * So the tick path only ever does `queue.push(record)`, which is one array
 * append, and a separate timer drains the backlog in one transaction between
 * ticks. Batching is a bonus: 50,000 rows in a single transaction take ~63 ms
 * on this hardware, versus ~1 s issued one at a time.
 */

export interface QueueOptions<T> {
  /** Called with a non-empty batch. Should be one transaction. */
  flush: (batch: T[]) => void;
  /** How often to drain. */
  intervalMs?: number;
  /** Drain immediately once the backlog reaches this size. */
  maxBatch?: number;
  /**
   * Hard ceiling on the backlog. If the database is wedged, dropping the oldest
   * entries keeps memory bounded instead of turning a stalled disk into an OOM.
   */
  maxPending?: number;
  onError?: (error: unknown, batch: T[]) => void;
  onDrop?: (dropped: number) => void;
}

export interface QueueStats {
  pending: number;
  written: number;
  dropped: number;
  failed: number;
  lastFlushMs: number;
  maxFlushMs: number;
}

export class WriteQueue<T> {
  private pending: T[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  private written = 0;
  private dropped = 0;
  private failed = 0;
  private lastFlushMs = 0;
  private maxFlushMs = 0;

  private readonly flush: (batch: T[]) => void;
  private readonly intervalMs: number;
  private readonly maxBatch: number;
  private readonly maxPending: number;
  private readonly onError?: (error: unknown, batch: T[]) => void;
  private readonly onDrop?: (dropped: number) => void;

  constructor(options: QueueOptions<T>) {
    this.flush = options.flush;
    this.intervalMs = options.intervalMs ?? 250;
    this.maxBatch = options.maxBatch ?? 64;
    this.maxPending = options.maxPending ?? 10_000;
    this.onError = options.onError;
    this.onDrop = options.onDrop;
  }

  /**
   * Enqueue. Safe to call from the simulation loop: one array append, no I/O,
   * and it never throws.
   */
  push(item: T): void {
    this.pending.push(item);
    if (this.pending.length > this.maxPending) {
      const excess = this.pending.length - this.maxPending;
      this.pending.splice(0, excess);
      this.dropped += excess;
      this.onDrop?.(excess);
    }
    // A burst does not wait for the next tick of the timer.
    if (this.pending.length >= this.maxBatch) this.drain();
  }

  /** Write everything queued. Returns how many rows were handed to `flush`. */
  drain(): number {
    if (this.draining || this.pending.length === 0) return 0;
    this.draining = true;
    const batch = this.pending;
    this.pending = [];
    const started = performance.now();
    try {
      this.flush(batch);
      this.written += batch.length;
      return batch.length;
    } catch (error) {
      this.failed += batch.length;
      // Deliberately NOT re-queued: a batch that throws will usually throw
      // again, and retrying forever turns one bad row into an infinite loop
      // that also blocks every later write.
      this.onError?.(error, batch);
      return 0;
    } finally {
      this.lastFlushMs = performance.now() - started;
      if (this.lastFlushMs > this.maxFlushMs) this.maxFlushMs = this.lastFlushMs;
      this.draining = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.drain(), this.intervalMs);
    // Never hold the process open just to run the flush timer.
    this.timer.unref?.();
  }

  /** Stop the timer and write whatever is left — call this on shutdown. */
  stop(): number {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.drain();
  }

  get size(): number {
    return this.pending.length;
  }

  stats(): QueueStats {
    return {
      pending: this.pending.length,
      written: this.written,
      dropped: this.dropped,
      failed: this.failed,
      lastFlushMs: Number(this.lastFlushMs.toFixed(3)),
      maxFlushMs: Number(this.maxFlushMs.toFixed(3)),
    };
  }
}

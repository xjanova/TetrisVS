import type { CoreEvent } from '@tetrisvs/core';

type ToneShape = OscillatorType | 'noise';

const MASTER_GAIN = 0.22;
/** Ceiling on scheduled one-shots so a burst of events cannot flood the timer queue. */
const MAX_PENDING = 48;
/** Longest we will wait for an AudioContext to resume before starting without it. */
const UNLOCK_TIMEOUT_MS = 1500;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Synthesised 16-bit-style audio.
 *
 * Every entry point is failure-tolerant on purpose: a blocked AudioContext, a
 * machine with no output device, or a browser that refuses to resume must cost
 * the player sound, never the match. `unlock()` therefore resolves instead of
 * rejecting, and every node call is guarded.
 */
export class ChipAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicTimer = 0;
  private beat = 0;
  private pending = new Set<number>();
  private failed = false;
  muted = false;

  /** True when audio could not be started; the UI can say so instead of looking broken. */
  get unavailable(): boolean {
    return this.failed;
  }

  /** Never rejects. Returns whether sound is actually available. */
  async unlock(): Promise<boolean> {
    if (this.failed) return false;
    try {
      if (!this.context) {
        const Ctor: typeof AudioContext | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          this.failed = true;
          return false;
        }
        this.context = new Ctor();
        this.master = this.context.createGain();
        this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
        this.master.connect(this.context.destination);
      }
      if (this.context.state === 'suspended') {
        // `resume()` can hang indefinitely when there is no output device — and
        // the match start is waiting on this promise. Cap it: worst case the
        // player gets no sound, never a menu button that does nothing.
        await Promise.race([this.context.resume(), sleep(UNLOCK_TIMEOUT_MS)]);
      }
      return this.context.state === 'running';
    } catch (error) {
      console.warn('[tetrisvs] audio unavailable:', error);
      this.failed = true;
      this.context = null;
      this.master = null;
      return false;
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (!this.master || !this.context) return;
    try {
      this.master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, this.context.currentTime, 0.015);
    } catch {
      /* a closed context is not worth a crash */
    }
  }

  startMusic() {
    if (this.musicTimer || !this.context) return;
    const notes = [110, 164.81, 220, 246.94, 220, 164.81, 130.81, 196];
    this.musicTimer = window.setInterval(() => {
      if (!this.context || this.muted) return;
      const note = notes[this.beat++ % notes.length]!;
      this.tone(note, 0.075, 'square', 0.025, -9);
      if (this.beat % 2 === 0) this.tone(note * 2, 0.035, 'triangle', 0.014, 0);
    }, 150);
  }

  stopMusic() {
    window.clearInterval(this.musicTimer);
    this.musicTimer = 0;
    this.beat = 0;
    this.cancelPending();
  }

  /** Drop every queued one-shot — quitting a match must not keep chirping. */
  private cancelPending() {
    for (const id of this.pending) window.clearTimeout(id);
    this.pending.clear();
  }

  private later(delayMs: number, run: () => void) {
    if (this.pending.size >= MAX_PENDING) return;
    const id = window.setTimeout(() => {
      this.pending.delete(id);
      run();
    }, delayMs);
    this.pending.add(id);
  }

  /** Release the AudioContext. Safe to call more than once. */
  dispose() {
    this.stopMusic();
    const context = this.context;
    this.context = null;
    this.master = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }

  events(events: readonly CoreEvent[]) {
    if (!this.context || this.muted) return;
    for (const event of events) {
      switch (event.t) {
        case 'move': this.tone(120, 0.018, 'square', 0.025, 30); break;
        case 'rotate': this.tone(event.tspin ? 740 : 390, 0.045, 'square', 0.04, 120); break;
        case 'softDrop': break;
        case 'hardDrop': this.noise(0.055, 0.07); this.tone(72, 0.08, 'sawtooth', 0.04, -20); break;
        case 'hold': this.tone(310, 0.08, 'triangle', 0.05, 210); break;
        case 'holdDenied': this.tone(78, 0.13, 'square', 0.055, -25); break;
        case 'lineClear': {
          const count = event.rows.length;
          for (let i = 0; i < count + 1; i++) {
            this.later(i * 42, () => this.tone(330 * (1 + i * 0.25), 0.12, 'square', 0.055, 80));
          }
          break;
        }
        case 'comboUp': this.tone(520 + event.combo * 55, 0.08, 'square', 0.045, 110); break;
        case 'b2bUp': this.tone(880, 0.2, 'square', 0.04, -170); break;
        case 'garbageIncoming': this.tone(92, 0.18, 'sawtooth', 0.06, 20); break;
        case 'garbageApplied': this.noise(0.18, 0.12); break;
        case 'countdown': this.tone(event.value === 0 ? 660 : 220 + event.value * 55, 0.12, 'square', 0.07, 0); break;
        case 'topout': this.tone(180, 0.45, 'sawtooth', 0.08, -150); break;
        case 'matchEnd': this.victory(); break;
      }
    }
  }

  private victory() {
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
      this.later(index * 105, () => this.tone(frequency, 0.22, 'square', 0.065, 0));
    });
  }

  private tone(frequency: number, duration: number, shape: ToneShape, volume: number, slide: number) {
    if (!this.context || !this.master || this.muted || shape === 'noise') return;
    try {
      const now = this.context.currentTime;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = shape;
      oscillator.frequency.setValueAtTime(frequency, now);
      oscillator.frequency.linearRampToValueAtTime(Math.max(35, frequency + slide), now + duration);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      oscillator.connect(gain).connect(this.master);
      oscillator.start(now);
      oscillator.stop(now + duration);
      // Free the graph node as soon as it has played.
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    } catch {
      /* one lost blip is not worth interrupting the game */
    }
  }

  private noise(duration: number, volume: number) {
    if (!this.context || !this.master || this.muted) return;
    try {
      const frames = Math.ceil(this.context.sampleRate * duration);
      const buffer = this.context.createBuffer(1, frames, this.context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      gain.gain.value = volume;
      source.buffer = buffer;
      source.connect(gain).connect(this.master);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
      source.start();
    } catch {
      /* see tone() */
    }
  }
}

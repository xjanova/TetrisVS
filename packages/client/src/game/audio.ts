import type { CoreEvent } from '@tetrisvs/core';

type ToneShape = OscillatorType | 'noise';

export class ChipAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicTimer = 0;
  private beat = 0;
  muted = false;

  async unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.22, this.context.currentTime, 0.015);
    }
  }

  startMusic() {
    if (this.musicTimer || !this.context) return;
    const notes = [110, 164.81, 220, 246.94, 220, 164.81, 130.81, 196];
    this.musicTimer = window.setInterval(() => {
      if (!this.context || this.muted) return;
      const note = notes[this.beat++ % notes.length];
      this.tone(note, 0.075, 'square', 0.025, -9);
      if (this.beat % 2 === 0) this.tone(note * 2, 0.035, 'triangle', 0.014, 0);
    }, 150);
  }

  stopMusic() {
    window.clearInterval(this.musicTimer);
    this.musicTimer = 0;
    this.beat = 0;
  }

  events(events: CoreEvent[]) {
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
            window.setTimeout(() => this.tone(330 * (1 + i * 0.25), 0.12, 'square', 0.055, 80), i * 42);
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
      window.setTimeout(() => this.tone(frequency, 0.22, 'square', 0.065, 0), index * 105);
    });
  }

  private tone(frequency: number, duration: number, shape: ToneShape, volume: number, slide: number) {
    if (!this.context || !this.master || this.muted || shape === 'noise') return;
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
  }

  private noise(duration: number, volume: number) {
    if (!this.context || !this.master || this.muted) return;
    const frames = Math.ceil(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, frames, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(gain).connect(this.master);
    source.start();
  }
}

import type { Cell, CoreEvent, PieceType, PlayerState } from '@tetrisvs/core';
import { BOARD_H_TOTAL, BOARD_W, cellsOf } from '@tetrisvs/core';
import { PIECE_COLORS } from './pieces';

const LOGICAL_W = 320;
const LOGICAL_H = 640;
const CELL = 32;
const VISIBLE_H = 20;
const HIDDEN_ROWS = BOARD_H_TOTAL - VISIBLE_H;
/** Room around a block sprite for its glow. */
const GLOW_PAD = 7;
const SPRITE = CELL + GLOW_PAD * 2;
const GARBAGE_COLOR = '#8990a9';
/** Particles are the only unbounded allocation in the draw path. */
const MAX_PARTICLES = 900;
/** Longest frame we integrate; a stalled tab must not teleport every effect. */
const MAX_DELTA = 1 / 15;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}

/** Offsets, in cells, for a piece in a rotation. Cached — the draw path ran this thousands of times a second. */
const OFFSET_CACHE = new Map<string, ReadonlyArray<readonly [number, number]>>();

export function offsets(type: PieceType, rotation: number): ReadonlyArray<readonly [number, number]> {
  const key = `${type}${rotation}`;
  let cached = OFFSET_CACHE.get(key);
  if (!cached) {
    cached = cellsOf(type, rotation as 0 | 1 | 2 | 3).map(({ x, y }) => [x, y] as const);
    OFFSET_CACHE.set(key, cached);
  }
  return cached;
}

/**
 * Playfield renderer.
 *
 * Three things used to make this the hot spot of the whole client and the
 * reason frame times spiked whenever a board filled up:
 *   - `shadowBlur` on every block, every frame (canvas shadows are not cached)
 *   - a fresh gradient plus 160 scanline rects for the backdrop, every frame
 *   - `getContext('2d')` and a piece-offset `map()` allocation per draw
 *
 * All three are now baked once into offscreen canvases. Effect decay is
 * integrated against real elapsed time as well, so a 144 Hz monitor no longer
 * plays every flash and shake 2.4x faster than a 60 Hz one.
 */
export class BoardRenderer {
  private context: CanvasRenderingContext2D | null;
  private particles: Particle[] = [];
  private flash = 0;
  private shake = 0;
  private warning = 0;
  private lastNow = 0;
  private dpr = 0;
  private backdrop: HTMLCanvasElement | null = null;
  private readonly sprites = new Map<string, HTMLCanvasElement>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.context = canvas.getContext('2d');
  }

  consume(events: readonly CoreEvent[]) {
    for (const event of events) {
      if (event.t === 'lineClear') {
        this.flash = 1;
        this.shake = Math.max(this.shake, event.rows.length * 2.2);
        const budget = Math.max(0, MAX_PARTICLES - this.particles.length);
        const perRow = Math.min(34, Math.floor(budget / Math.max(1, event.rows.length)));
        for (const row of event.rows) {
          for (let i = 0; i < perRow; i++) {
            this.particles.push({
              x: Math.random() * LOGICAL_W,
              y: (row - HIDDEN_ROWS + 0.5) * CELL,
              vx: (Math.random() - 0.5) * 300,
              vy: -60 - Math.random() * 240,
              life: 1,
              color: `hsl(${175 + Math.random() * 150} 100% 68%)`,
              size: 2 + Math.random() * 6,
            });
          }
        }
      }
      if (event.t === 'hardDrop') this.shake = Math.max(this.shake, 2.5);
      if (event.t === 'garbageApplied') this.shake = Math.max(this.shake, 7);
      if (event.t === 'garbageIncoming') this.warning = 1;
      if (event.t === 'topout') {
        this.flash = 1.5;
        this.shake = 11;
      }
    }
  }

  render(player: PlayerState, now: number) {
    const context = this.context;
    if (!context) return;

    const delta = this.lastNow ? Math.min(MAX_DELTA, Math.max(0, (now - this.lastNow) / 1000)) : 1 / 60;
    this.lastNow = now;
    // Everything below decays per-second, converted from the old per-frame rates
    // by raising them to the number of 60 Hz frames this frame represents.
    const frames = delta * 60;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.dpr !== dpr || this.canvas.width !== LOGICAL_W * dpr) {
      this.dpr = dpr;
      this.canvas.width = LOGICAL_W * dpr;
      this.canvas.height = LOGICAL_H * dpr;
      this.backdrop = null;
      this.sprites.clear();
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

    const sx = this.shake > 0.05 ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake > 0.05 ? (Math.random() - 0.5) * this.shake : 0;
    context.save();
    context.translate(sx, sy);
    context.drawImage(this.backdropCanvas(), 0, 0, LOGICAL_W, LOGICAL_H);
    this.drawBoard(context, player.board);
    this.drawGhost(context, player);
    this.drawActive(context, player);
    this.drawParticles(context, delta);
    context.restore();

    if (this.warning > 0.02) {
      context.strokeStyle = `rgba(255, 52, 104, ${Math.min(0.9, this.warning * (0.55 + Math.sin(now / 55) * 0.25))})`;
      context.lineWidth = 7;
      context.strokeRect(4, 4, LOGICAL_W - 8, LOGICAL_H - 8);
    }
    if (this.flash > 0.01) {
      context.fillStyle = `rgba(255,255,255,${Math.min(0.4, this.flash * 0.3)})`;
      context.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    }

    this.flash *= Math.pow(0.84, frames);
    this.shake *= Math.pow(0.78, frames);
    this.warning *= Math.pow(0.97, frames);
    if (this.flash < 0.01) this.flash = 0;
    if (this.shake < 0.05) this.shake = 0;
    if (this.warning < 0.02) this.warning = 0;
  }

  /** Drop cached canvases. Call when the board unmounts. */
  dispose() {
    this.particles.length = 0;
    this.sprites.clear();
    this.backdrop = null;
    this.context = null;
  }

  // -------------------------------------------------------------- cached art

  private backdropCanvas(): HTMLCanvasElement {
    if (this.backdrop) return this.backdrop;
    const scale = this.dpr || 1;
    const canvas = document.createElement('canvas');
    canvas.width = LOGICAL_W * scale;
    canvas.height = LOGICAL_H * scale;
    const context = canvas.getContext('2d')!;
    context.setTransform(scale, 0, 0, scale, 0, 0);

    const gradient = context.createLinearGradient(0, 0, 0, LOGICAL_H);
    gradient.addColorStop(0, '#10122a');
    gradient.addColorStop(0.55, '#090b1d');
    gradient.addColorStop(1, '#060715');
    context.fillStyle = gradient;
    context.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    context.fillStyle = 'rgba(91, 92, 255, 0.02)';
    for (let y = 0; y < LOGICAL_H; y += 4) context.fillRect(0, y, LOGICAL_W, 1);

    context.strokeStyle = 'rgba(164, 183, 255, 0.055)';
    context.lineWidth = 1;
    context.beginPath();
    for (let x = 1; x < BOARD_W; x++) {
      context.moveTo(x * CELL + 0.5, 0);
      context.lineTo(x * CELL + 0.5, LOGICAL_H);
    }
    for (let y = 1; y < VISIBLE_H; y++) {
      context.moveTo(0, y * CELL + 0.5);
      context.lineTo(LOGICAL_W, y * CELL + 0.5);
    }
    context.stroke();

    this.backdrop = canvas;
    return canvas;
  }

  /**
   * One sprite per colour, glow and shine baked in. `drawImage` of a cached
   * bitmap is roughly an order of magnitude cheaper than re-running a shadowed
   * fill plus a gradient for each of the ~200 blocks on screen.
   */
  private sprite(color: string, ghost: boolean): HTMLCanvasElement {
    const key = `${color}${ghost ? 'g' : ''}`;
    const cached = this.sprites.get(key);
    if (cached) return cached;

    const scale = this.dpr || 1;
    const canvas = document.createElement('canvas');
    canvas.width = SPRITE * scale;
    canvas.height = SPRITE * scale;
    const context = canvas.getContext('2d')!;
    context.setTransform(scale, 0, 0, scale, 0, 0);

    const px = GLOW_PAD + 2;
    const py = GLOW_PAD + 2;
    const size = CELL - 4;

    if (ghost) {
      context.globalAlpha = 0.28;
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.strokeRect(px + 2, py + 2, size - 4, size - 4);
    } else {
      context.shadowColor = color;
      context.shadowBlur = 10;
      context.fillStyle = color;
      context.fillRect(px, py, size, size);
      context.shadowBlur = 0;
      const shine = context.createLinearGradient(px, py, px, py + size);
      shine.addColorStop(0, 'rgba(255,255,255,.58)');
      shine.addColorStop(0.28, 'rgba(255,255,255,.1)');
      shine.addColorStop(1, 'rgba(0,0,0,.22)');
      context.fillStyle = shine;
      context.fillRect(px + 2, py + 2, size - 4, size - 4);
      context.strokeStyle = 'rgba(255,255,255,.35)';
      context.strokeRect(px + 1.5, py + 1.5, size - 3, size - 3);
    }

    this.sprites.set(key, canvas);
    return canvas;
  }

  private drawBlock(context: CanvasRenderingContext2D, x: number, y: number, color: string, ghost: boolean) {
    context.drawImage(this.sprite(color, ghost), x * CELL - GLOW_PAD, y * CELL - GLOW_PAD, SPRITE, SPRITE);
  }

  // -------------------------------------------------------------- board

  private drawBoard(context: CanvasRenderingContext2D, board: readonly Cell[]) {
    for (let y = HIDDEN_ROWS; y < BOARD_H_TOTAL; y++) {
      const rowBase = y * BOARD_W;
      for (let x = 0; x < BOARD_W; x++) {
        const cell = board[rowBase + x];
        if (!cell) continue;
        this.drawBlock(context, x, y - HIDDEN_ROWS, cell === 'G' ? GARBAGE_COLOR : PIECE_COLORS[cell], false);
      }
    }
  }

  private drawActive(context: CanvasRenderingContext2D, player: PlayerState) {
    const active = player.active;
    if (!active) return;
    const color = PIECE_COLORS[active.type];
    for (const [dx, dy] of offsets(active.type, active.rot)) {
      const y = active.y + dy - HIDDEN_ROWS;
      if (y >= 0) this.drawBlock(context, active.x + dx, y, color, false);
    }
  }

  private drawGhost(context: CanvasRenderingContext2D, player: PlayerState) {
    const active = player.active;
    if (!active) return;
    const cells = offsets(active.type, active.rot);
    const color = PIECE_COLORS[active.type];

    let drop = 0;
    while (drop <= BOARD_H_TOTAL && this.fits(player, cells, drop + 1)) drop++;
    if (drop === 0) return;

    for (const [dx, dy] of cells) {
      const y = active.y + dy + drop - HIDDEN_ROWS;
      if (y >= 0) this.drawBlock(context, active.x + dx, y, color, true);
    }
  }

  private fits(player: PlayerState, cells: ReadonlyArray<readonly [number, number]>, drop: number): boolean {
    const active = player.active!;
    for (const [dx, dy] of cells) {
      const x = active.x + dx;
      const y = active.y + dy + drop;
      if (x < 0 || x >= BOARD_W || y >= BOARD_H_TOTAL) return false;
      if (y >= 0 && player.board[y * BOARD_W + x]) return false;
    }
    return true;
  }

  // -------------------------------------------------------------- particles

  private drawParticles(context: CanvasRenderingContext2D, delta: number) {
    if (this.particles.length === 0) return;
    const decay = Math.pow(0.93, delta * 60);
    let write = 0;

    for (let read = 0; read < this.particles.length; read++) {
      const particle = this.particles[read]!;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      particle.vy += 648 * delta;
      particle.life *= decay;
      if (particle.life <= 0.03) continue;

      context.globalAlpha = particle.life;
      context.fillStyle = particle.color;
      context.fillRect(particle.x, particle.y, particle.size, particle.size);
      // Compact in place instead of allocating a new array every frame.
      this.particles[write++] = particle;
    }

    this.particles.length = write;
    context.globalAlpha = 1;
  }
}

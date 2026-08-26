import type { Cell, CoreEvent, PlayerState } from '@tetrisvs/core';
import { BOARD_H_TOTAL, BOARD_W } from '@tetrisvs/core';
import { PIECE_COLORS, pieceCells } from './pieces';

const LOGICAL_W = 320;
const LOGICAL_H = 640;
const CELL = 32;
const VISIBLE_H = 20;
const HIDDEN_ROWS = BOARD_H_TOTAL - VISIBLE_H;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}

export class BoardRenderer {
  private particles: Particle[] = [];
  private flash = 0;
  private shake = 0;
  private warning = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  consume(events: CoreEvent[]) {
    for (const event of events) {
      if (event.t === 'lineClear') {
        this.flash = 1;
        this.shake = Math.max(this.shake, event.rows.length * 2.2);
        for (const row of event.rows) {
          for (let i = 0; i < 34; i++) {
            const hue = 175 + Math.random() * 150;
            this.particles.push({
              x: Math.random() * LOGICAL_W,
              y: (row - HIDDEN_ROWS + 0.5) * CELL,
              vx: (Math.random() - 0.5) * 5,
              vy: -1 - Math.random() * 4,
              life: 1,
              color: `hsl(${hue} 100% 68%)`,
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
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== LOGICAL_W * dpr || this.canvas.height !== LOGICAL_H * dpr) {
      this.canvas.width = LOGICAL_W * dpr;
      this.canvas.height = LOGICAL_H * dpr;
    }
    const context = this.canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
    const sx = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    context.save();
    context.translate(sx, sy);
    this.drawBackdrop(context, now);
    this.drawGrid(context);
    this.drawBoard(context, player.board);
    this.drawGhost(context, player);
    this.drawActive(context, player);
    this.drawParticles(context);
    context.restore();

    if (this.warning > 0) {
      context.strokeStyle = `rgba(255, 52, 104, ${Math.min(0.9, this.warning * (0.55 + Math.sin(now / 55) * 0.25))})`;
      context.lineWidth = 7;
      context.strokeRect(4, 4, LOGICAL_W - 8, LOGICAL_H - 8);
    }
    if (this.flash > 0) {
      context.fillStyle = `rgba(255,255,255,${Math.min(0.4, this.flash * 0.3)})`;
      context.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    }
    this.flash *= 0.84;
    this.shake *= 0.78;
    this.warning *= 0.97;
  }

  private drawBackdrop(context: CanvasRenderingContext2D, now: number) {
    const gradient = context.createLinearGradient(0, 0, 0, LOGICAL_H);
    gradient.addColorStop(0, '#10122a');
    gradient.addColorStop(0.55, '#090b1d');
    gradient.addColorStop(1, '#060715');
    context.fillStyle = gradient;
    context.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    context.fillStyle = `rgba(91, 92, 255, ${0.018 + Math.sin(now / 1100) * 0.007})`;
    for (let y = 0; y < LOGICAL_H; y += 4) context.fillRect(0, y, LOGICAL_W, 1);
  }

  private drawGrid(context: CanvasRenderingContext2D) {
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
  }

  private drawBoard(context: CanvasRenderingContext2D, board: Cell[]) {
    for (let y = HIDDEN_ROWS; y < BOARD_H_TOTAL; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        const cell = board[y * BOARD_W + x];
        if (cell) this.drawBlock(context, x, y - HIDDEN_ROWS, cell === 'G' ? '#8990a9' : PIECE_COLORS[cell], false);
      }
    }
  }

  private drawActive(context: CanvasRenderingContext2D, player: PlayerState) {
    const active = player.active;
    if (!active) return;
    for (const [dx, dy] of pieceCells(active.type, active.rot)) {
      const y = active.y + dy - HIDDEN_ROWS;
      if (y >= 0) this.drawBlock(context, active.x + dx, y, PIECE_COLORS[active.type], false);
    }
  }

  private drawGhost(context: CanvasRenderingContext2D, player: PlayerState) {
    const active = player.active;
    if (!active) return;
    let drop = 0;
    while (this.canPlace(player, drop + 1)) drop++;
    for (const [dx, dy] of pieceCells(active.type, active.rot)) {
      const y = active.y + dy + drop - HIDDEN_ROWS;
      if (y >= 0) this.drawBlock(context, active.x + dx, y, PIECE_COLORS[active.type], true);
    }
  }

  private canPlace(player: PlayerState, drop: number) {
    const active = player.active;
    if (!active) return false;
    return pieceCells(active.type, active.rot).every(([dx, dy]) => {
      const x = active.x + dx;
      const y = active.y + dy + drop;
      return x >= 0 && x < BOARD_W && y < BOARD_H_TOTAL && (y < 0 || !player.board[y * BOARD_W + x]);
    });
  }

  private drawBlock(context: CanvasRenderingContext2D, x: number, y: number, color: string, ghost: boolean) {
    const px = x * CELL + 2;
    const py = y * CELL + 2;
    const size = CELL - 4;
    context.save();
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
      const shine = context.createLinearGradient(px, py, px, py + size);
      shine.addColorStop(0, 'rgba(255,255,255,.58)');
      shine.addColorStop(0.28, 'rgba(255,255,255,.1)');
      shine.addColorStop(1, 'rgba(0,0,0,.22)');
      context.fillStyle = shine;
      context.fillRect(px + 2, py + 2, size - 4, size - 4);
      context.strokeStyle = 'rgba(255,255,255,.35)';
      context.strokeRect(px + 1.5, py + 1.5, size - 3, size - 3);
    }
    context.restore();
  }

  private drawParticles(context: CanvasRenderingContext2D) {
    this.particles = this.particles.filter((particle) => particle.life > 0.03);
    for (const particle of this.particles) {
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += 0.18;
      particle.life *= 0.93;
      context.globalAlpha = particle.life;
      context.fillStyle = particle.color;
      context.fillRect(particle.x, particle.y, particle.size, particle.size);
    }
    context.globalAlpha = 1;
  }
}

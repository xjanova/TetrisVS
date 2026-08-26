import { useEffect, useRef } from 'react';
import type { CoreEvent, PlayerState } from '@tetrisvs/core';
import { BoardRenderer } from '../game/renderer';

interface BoardCanvasProps {
  player: PlayerState;
  events: readonly CoreEvent[];
  eventId: number;
}

/**
 * Stable per-board digest, read by the end-to-end harness to prove two clients
 * really are looking at two different playfields. `Cell` is `0 | PieceType | 'G'`,
 * so the `typeof` guard is what keeps an empty cell from being treated as text.
 */
function boardFingerprint(player: PlayerState) {
  let hash = 2166136261;
  for (const cell of player.board) hash = Math.imul(hash ^ (typeof cell === 'string' ? cell.charCodeAt(0) : 0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function BoardCanvas({ player, events, eventId }: BoardCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<BoardRenderer | null>(null);
  const playerRef = useRef(player);
  const animation = useRef(0);
  const consumedId = useRef(-1);
  playerRef.current = player;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const instance = new BoardRenderer(element);
    renderer.current = instance;
    consumedId.current = -1;

    const draw = (now: number) => {
      instance.render(playerRef.current, now);
      animation.current = requestAnimationFrame(draw);
    };
    animation.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animation.current);
      instance.dispose();
      if (renderer.current === instance) renderer.current = null;
    };
  }, []);

  useEffect(() => {
    // `events` is a fresh array on every parent render, so keying the effect on
    // it alone replayed the same batch dozens of times — every line clear
    // spawned its particles again and again until the next batch arrived.
    if (eventId === consumedId.current) return;
    consumedId.current = eventId;
    if (events.length) renderer.current?.consume(events);
  }, [eventId, events]);

  return <canvas ref={canvas} className="board-canvas" aria-label="Tetris playfield" data-board-hash={boardFingerprint(player)} />;
}

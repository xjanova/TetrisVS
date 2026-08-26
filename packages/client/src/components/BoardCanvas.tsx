import { useEffect, useRef } from 'react';
import type { CoreEvent, PlayerState } from '@tetrisvs/core';
import { BoardRenderer } from '../game/renderer';

interface BoardCanvasProps {
  player: PlayerState;
  events: CoreEvent[];
  eventId: number;
}

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
  playerRef.current = player;

  useEffect(() => {
    if (!canvas.current) return;
    renderer.current = new BoardRenderer(canvas.current);
    const draw = (now: number) => {
      renderer.current?.render(playerRef.current, now);
      animation.current = requestAnimationFrame(draw);
    };
    animation.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation.current);
  }, []);

  useEffect(() => {
    renderer.current?.consume(events);
  }, [eventId, events]);

  return <canvas ref={canvas} className="board-canvas" aria-label="Tetris playfield" data-board-hash={boardFingerprint(player)} />;
}

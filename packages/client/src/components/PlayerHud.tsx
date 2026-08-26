import { useMemo } from 'react';
import type { MatchState, PlayerId } from '@tetrisvs/core';
import { levelAt, nextPieces, NEXT_COUNT } from '@tetrisvs/core';
import { PiecePreview } from './PiecePreview';

interface PlayerHudProps {
  state: MatchState;
  playerId: PlayerId;
}

export function PlayerHud({ state, playerId }: PlayerHudProps) {
  const player = state.players[playerId];

  // The queue is derived from (seed, bagIndex), so it only changes when a piece
  // is taken — not on every one of the 60 state updates a second.
  const queue = useMemo(
    () => nextPieces(state.seed, player.bagIndex, NEXT_COUNT),
    [state.seed, player.bagIndex],
  );

  const incoming = useMemo(
    () => player.garbageQueue.reduce((sum, item) => sum + item.amount, 0),
    [player.garbageQueue],
  );

  const level = levelAt(state.frame);

  return (
    <aside className={`player-hud player-hud--p${playerId + 1}`}>
      <div className="hud-label">HOLD</div>
      <PiecePreview piece={player.hold} />
      <div className="stat-stack">
        <div><span>LINES</span><strong>{player.linesCleared}</strong></div>
        <div><span>ATTACK</span><strong>{player.attackSent}</strong></div>
        <div><span>COMBO</span><strong>{Math.max(0, player.combo)}</strong></div>
        <div><span>LEVEL</span><strong>{level}</strong></div>
      </div>
      {player.backToBack && <div className="b2b-badge">BACK × BACK</div>}
      {incoming > 0 && <div className="danger-badge">⚠ {incoming} INCOMING</div>}
      <div className="hud-label next-label">NEXT</div>
      <div className="next-stack">
        {queue.map((piece, index) => <PiecePreview key={`${piece}-${index}`} piece={piece} small={index > 0} />)}
      </div>
    </aside>
  );
}

import type { MatchState, PlayerId } from '@tetrisvs/core';
import { nextPieces } from '@tetrisvs/core';
import { PiecePreview } from './PiecePreview';

interface PlayerHudProps {
  state: MatchState;
  playerId: PlayerId;
}

export function PlayerHud({ state, playerId }: PlayerHudProps) {
  const player = state.players[playerId];
  const queue = nextPieces(state.seed, player.bagIndex, 5);
  const incoming = player.garbageQueue.reduce((sum, item) => sum + item.amount, 0);

  return (
    <aside className={`player-hud player-hud--p${playerId + 1}`}>
      <div className="hud-label">HOLD</div>
      <PiecePreview piece={player.hold} />
      <div className="stat-stack">
        <div><span>LINES</span><strong>{player.linesCleared}</strong></div>
        <div><span>ATTACK</span><strong>{player.attackSent}</strong></div>
        <div><span>COMBO</span><strong>{Math.max(0, player.combo)}</strong></div>
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

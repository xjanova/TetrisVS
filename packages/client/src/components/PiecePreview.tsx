import type { PieceType } from '@tetrisvs/core';
import { PIECE_COLORS, pieceCells } from '../game/pieces';

export function PiecePreview({ piece, small = false }: { piece: PieceType | null; small?: boolean }) {
  return (
    <div className={`piece-preview ${small ? 'piece-preview--small' : ''}`}>
      {piece && pieceCells(piece).map(([x, y], index) => (
        <i
          key={`${x}-${y}-${index}`}
          style={{
            '--x': x,
            '--y': y,
            '--piece': PIECE_COLORS[piece],
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

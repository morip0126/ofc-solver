import type { Card } from '../domain'
import { isRedSuit, rankChar, suitSymbol } from './format'

export function CardGlyph({ card, size = 'md' }: { card: Card; size?: 'sm' | 'md' }) {
  return (
    <span className={`card-glyph ${size} ${isRedSuit(card.suit) ? 'red' : 'black'}`}>
      <span className="rank">{rankChar(card.rank)}</span>
      <span className="suit">{suitSymbol(card.suit)}</span>
    </span>
  )
}

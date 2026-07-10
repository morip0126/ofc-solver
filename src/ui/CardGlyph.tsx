import type { Card } from '../domain'
import { rankChar, suitSymbol } from './format'

export function CardGlyph({ card, size = 'md' }: { card: Card; size?: 'sm' | 'md' }) {
  if (card.rank === 0) {
    return (
      <span className={`card-glyph ${size} joker`}>
        <span className="rank">🃏</span>
      </span>
    )
  }
  // 4色デッキ: ♠黒 / ♥赤 / ♦青 / ♣緑（suit-* クラスで色分け）
  return (
    <span className={`card-glyph ${size} suit-${card.suit}`}>
      <span className="rank">{rankChar(card.rank)}</span>
      <span className="suit">{suitSymbol(card.suit)}</span>
    </span>
  )
}

// 表示用フォーマット。
import type { Card, Rank, Suit } from '../domain'

const RANK_CHAR: Record<Rank, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
}

const SUIT_SYMBOL: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' }

export function rankChar(rank: Rank): string {
  return RANK_CHAR[rank]
}

export function suitSymbol(suit: Suit): string {
  return SUIT_SYMBOL[suit]
}

/** ハート・ダイヤは赤。 */
export function isRedSuit(suit: Suit): boolean {
  return suit === 'h' || suit === 'd'
}

export function formatCard(card: Card): string {
  return `${RANK_CHAR[card.rank]}${SUIT_SYMBOL[card.suit]}`
}

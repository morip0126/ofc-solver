// カード表現とデッキ操作。
// Card representation and basic deck helpers.

export type Suit = 'c' | 'd' | 'h' | 's'

/** ランクは 2..14（A=14, K=13, Q=12, J=11, T=10）。 */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14

/**
 * ジョーカー（ワイルド）はランク 0 で表す。2枚を区別するためスートに c / d を流用する
 * （表示・評価では特別扱いされ、スートとしての意味は持たない）。
 */
export const JOKER_RANK = 0
export type CardRank = Rank | typeof JOKER_RANK

export interface Card {
  readonly rank: CardRank
  readonly suit: Suit
}

/** ジョーカー判定。 */
export function isJoker(card: Card): boolean {
  return card.rank === JOKER_RANK
}

/** ジョーカー2枚（54枚デッキ用）。 */
export const JOKER_CARDS: readonly Card[] = [
  { rank: JOKER_RANK, suit: 'c' },
  { rank: JOKER_RANK, suit: 'd' },
]

export const SUITS: readonly Suit[] = ['c', 'd', 'h', 's']
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

const RANK_TO_CHAR: Record<Rank, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
}

const CHAR_TO_RANK: Record<string, Rank> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
  // 小文字も許容 / accept lowercase face chars
  t: 10, j: 11, q: 12, k: 13, a: 14,
}

/** "As", "Td", "2c" のような文字列をカードに変換する。ジョーカーは "X1" / "X2"。 */
export function parseCard(code: string): Card {
  if (code.length !== 2) throw new Error(`invalid card code: "${code}"`)
  if (code[0] === 'X' || code[0] === 'x') {
    if (code[1] === '1') return { rank: JOKER_RANK, suit: 'c' }
    if (code[1] === '2') return { rank: JOKER_RANK, suit: 'd' }
    throw new Error(`invalid joker code: "${code}" (use X1 or X2)`)
  }
  const rank = CHAR_TO_RANK[code[0]]
  const suit = code[1].toLowerCase() as Suit
  if (rank === undefined) throw new Error(`invalid rank in card code: "${code}"`)
  if (!SUITS.includes(suit)) throw new Error(`invalid suit in card code: "${code}"`)
  return { rank, suit }
}

/** カード配列を一括で文字列からパースする。空白/カンマ区切りも許容。 */
export function parseCards(codes: string | string[]): Card[] {
  const list = Array.isArray(codes) ? codes : codes.split(/[\s,]+/).filter(Boolean)
  return list.map(parseCard)
}

/** カードを "As" のような文字列に戻す。ジョーカーは "X1" / "X2"。 */
export function cardToString(card: Card): string {
  if (card.rank === JOKER_RANK) return card.suit === 'c' ? 'X1' : 'X2'
  return `${RANK_TO_CHAR[card.rank]}${card.suit}`
}

export function cardsToString(cards: readonly Card[]): string {
  return cards.map(cardToString).join(' ')
}

/** 同一カード判定。 */
export function cardsEqual(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit
}

/** 一意なカードID（0..51、ジョーカーは 52/53）。重複検出やSet化に使う。 */
export function cardId(card: Card): number {
  if (card.rank === JOKER_RANK) return 52 + (card.suit === 'c' ? 0 : 1)
  return (card.rank - 2) * 4 + SUITS.indexOf(card.suit)
}

/** pool から subset のカードを取り除いた配列を返す（同一カードID基準、非破壊）。 */
export function without(pool: readonly Card[], subset: readonly Card[]): Card[] {
  const remove = new Set(subset.map(cardId))
  return pool.filter((c) => !remove.has(cardId(c)))
}

/** 標準52枚デッキ（jokers=true でジョーカー2枚を加えた54枚）。 */
export function makeDeck(jokers = false): Card[] {
  const deck: Card[] = []
  for (const rank of RANKS) {
    for (const suit of SUITS) deck.push({ rank, suit })
  }
  if (jokers) deck.push(...JOKER_CARDS)
  return deck
}

/**
 * 使用済み（デッド）カードを除いた残りデッキを返す。
 * dead に重複や不正が含まれていても、結果は常にユニークな未使用カード集合になる。
 */
export function remainingDeck(dead: readonly Card[], jokers = false): Card[] {
  const used = new Set(dead.map(cardId))
  return makeDeck(jokers).filter((c) => !used.has(cardId(c)))
}

// ポーカーハンド評価。
// 5枚（bottom / middle）と3枚（top）の両方を、比較可能な数値配列に変換する。
//
// HandValue は [category, ...tiebreakers] という配列で、辞書式に比較すれば強さ順になる。
// top(3枚) は HighCard / Pair / Trips のみを取り得る（OFC の top ではストレート・フラッシュは役にならない）。

import type { Card, Rank } from './cards'

export enum HandCategory {
  HighCard = 0,
  Pair = 1,
  TwoPair = 2,
  Trips = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  Quads = 7,
  StraightFlush = 8,
}

/** [category, ...tiebreakers]。辞書式比較で強さ順になる。 */
export type HandValue = number[]

function rankCounts(ranks: Rank[]): { orderedRanks: number[]; counts: number[] } {
  const map = new Map<number, number>()
  for (const r of ranks) map.set(r, (map.get(r) ?? 0) + 1)
  // 出現回数の多い順、同数ならランクの高い順に並べる（キッカー順に一致する）。
  const groups = [...map.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  return {
    orderedRanks: groups.map((g) => g[0]),
    counts: groups.map((g) => g[1]),
  }
}

/** 5枚のランク集合がストレートなら最高札のランクを、そうでなければ 0 を返す。A-2-3-4-5 は 5 を返す。 */
function straightHigh5(ranks: Rank[]): number {
  const uniq = Array.from(new Set(ranks))
  if (uniq.length !== 5) return 0
  const sorted = uniq.slice().sort((a, b) => a - b)
  if (sorted[4] - sorted[0] === 4) return sorted[4]
  // ホイール A-2-3-4-5
  if (sorted[0] === 2 && sorted[1] === 3 && sorted[2] === 4 && sorted[3] === 5 && sorted[4] === 14) {
    return 5
  }
  return 0
}

/** 5枚ハンドを評価する。 */
export function evaluate5(cards: readonly Card[]): HandValue {
  if (cards.length !== 5) throw new Error(`evaluate5 expects 5 cards, got ${cards.length}`)
  const ranks = cards.map((c) => c.rank)
  const suits = cards.map((c) => c.suit)
  const isFlush = suits.every((s) => s === suits[0])
  const sh = straightHigh5(ranks)
  const { orderedRanks, counts } = rankCounts(ranks)
  const ranksDesc = ranks.slice().sort((a, b) => b - a)

  if (isFlush && sh) return [HandCategory.StraightFlush, sh]
  if (counts[0] === 4) return [HandCategory.Quads, orderedRanks[0], orderedRanks[1]]
  if (counts[0] === 3 && counts[1] === 2) {
    return [HandCategory.FullHouse, orderedRanks[0], orderedRanks[1]]
  }
  if (isFlush) return [HandCategory.Flush, ...ranksDesc]
  if (sh) return [HandCategory.Straight, sh]
  if (counts[0] === 3) return [HandCategory.Trips, orderedRanks[0], orderedRanks[1], orderedRanks[2]]
  if (counts[0] === 2 && counts[1] === 2) {
    return [HandCategory.TwoPair, orderedRanks[0], orderedRanks[1], orderedRanks[2]]
  }
  if (counts[0] === 2) {
    return [HandCategory.Pair, orderedRanks[0], orderedRanks[1], orderedRanks[2], orderedRanks[3]]
  }
  return [HandCategory.HighCard, ...ranksDesc]
}

/** 3枚（top）ハンドを評価する。取り得るのは HighCard / Pair / Trips のみ。 */
export function evaluate3(cards: readonly Card[]): HandValue {
  if (cards.length !== 3) throw new Error(`evaluate3 expects 3 cards, got ${cards.length}`)
  const ranks = cards.map((c) => c.rank)
  const { orderedRanks, counts } = rankCounts(ranks)
  const ranksDesc = ranks.slice().sort((a, b) => b - a)

  if (counts[0] === 3) return [HandCategory.Trips, orderedRanks[0]]
  if (counts[0] === 2) return [HandCategory.Pair, orderedRanks[0], orderedRanks[1]]
  return [HandCategory.HighCard, ...ranksDesc]
}

/** 段の枚数に応じて評価関数を選ぶ（3枚→top, 5枚→5枚役）。 */
export function evaluateRow(cards: readonly Card[]): HandValue {
  if (cards.length === 3) return evaluate3(cards)
  if (cards.length === 5) return evaluate5(cards)
  throw new Error(`evaluateRow expects 3 or 5 cards, got ${cards.length}`)
}

/**
 * ハンド強さの比較。a<b:-1, a==b:0, a>b:1。
 * 枚数の違う段（5枚 middle と 3枚 top）を比較するケースもあるため、短い方の長さまでで比較し、
 * そこまで完全一致ならタイ（0）とみなす。
 */
export function compareHand(a: HandValue, b: HandValue): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

export function categoryOf(value: HandValue): HandCategory {
  return value[0] as HandCategory
}

/** ロイヤルフラッシュ（A ハイのストレートフラッシュ）判定。 */
export function isRoyalFlush(value: HandValue): boolean {
  return value[0] === HandCategory.StraightFlush && value[1] === 14
}

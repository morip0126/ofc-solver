// ロイヤリティ（役ボーナス）表。広く使われている標準の Pineapple OFC ロイヤリティを実装する。
//
// top(3枚): 66=1, 77=2, ..., AA=9 / 222=10, 333=11, ..., AAA=22
// middle(5枚): bottom のおおむね倍（トリップス以上でボーナス）
// bottom(5枚): ストレート=2 ... ロイヤルフラッシュ=25

import { HandCategory, type HandValue, isRoyalFlush } from './evaluator'

const BOTTOM_TABLE: Partial<Record<HandCategory, number>> = {
  [HandCategory.Straight]: 2,
  [HandCategory.Flush]: 4,
  [HandCategory.FullHouse]: 6,
  [HandCategory.Quads]: 10,
  [HandCategory.StraightFlush]: 15,
}

const MIDDLE_TABLE: Partial<Record<HandCategory, number>> = {
  [HandCategory.Trips]: 2,
  [HandCategory.Straight]: 4,
  [HandCategory.Flush]: 8,
  [HandCategory.FullHouse]: 12,
  [HandCategory.Quads]: 20,
  [HandCategory.StraightFlush]: 30,
}

/** bottom 段のロイヤリティ。 */
export function royaltyBottom(v: HandValue): number {
  if (isRoyalFlush(v)) return 25
  return BOTTOM_TABLE[v[0] as HandCategory] ?? 0
}

/** middle 段のロイヤリティ。 */
export function royaltyMiddle(v: HandValue): number {
  if (isRoyalFlush(v)) return 50
  return MIDDLE_TABLE[v[0] as HandCategory] ?? 0
}

/** top 段のロイヤリティ（ペア 66 以上、またはスリーカード）。 */
export function royaltyTop(v: HandValue): number {
  const cat = v[0] as HandCategory
  if (cat === HandCategory.Trips) {
    // 222=10 ... AAA=22
    return 10 + (v[1] - 2)
  }
  if (cat === HandCategory.Pair) {
    const pairRank = v[1]
    if (pairRank < 6) return 0
    return pairRank - 5 // 66=1, 77=2, ..., AA=9
  }
  return 0
}

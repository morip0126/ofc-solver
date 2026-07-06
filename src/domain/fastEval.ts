// 高速評価コア。
//
// HandValue（[category, ...tiebreakers] の配列）を 24bit 整数キーにパックし、
// ホットパス（全探索・モンテカルロ・FLソルバー）での配列アロケーションと辞書式比較を避ける。
//
//   key = category << 20 | t1 << 16 | t2 << 12 | t3 << 8 | t4 << 4 | t5
//
// tiebreaker はランク（2..14）なので 4bit に収まる。使わない下位ニブルは 0 埋め。
// 0 埋めにより「短い方の長さまで比較して一致ならタイ」という compareHand の切り詰め比較と
// ファウル判定（middle >= top）の意味論が整数比較で完全に一致する
// （最初の実ニブルで差が付けば 0 埋めは影響せず、全ニブル一致=タイは 0埋め側 <= となり非ファウル）。
//
// 正しさは evaluator.ts / royalties.ts とのクロスチェックテスト（fastEval.test.ts）で担保する。

import type { Card } from './cards'
import { HandCategory, type HandValue } from './evaluator'

/** HandValue を 24bit キーにパックする。tiebreakers は最大5つ。 */
export function packHandValue(v: HandValue): number {
  let key = v[0] << 20
  const n = Math.min(v.length - 1, 5)
  for (let i = 1; i <= n; i++) key |= v[i] << (20 - 4 * i)
  return key
}

/** 24bit キーを HandValue に戻す（ランクに 0 は無いので 0 ニブル以降は打ち切り）。 */
export function unpackHandValue(key: number): HandValue {
  const v: HandValue = [key >>> 20]
  for (let shift = 16; shift >= 0; shift -= 4) {
    const nib = (key >>> shift) & 0xf
    if (nib === 0) break
    v.push(nib)
  }
  return v
}

export function keyCategory(key: number): HandCategory {
  return (key >>> 20) as HandCategory
}

// ランク出現数を数えるスクラッチ（毎回の配列アロケーションを避ける）。
const cnt = new Uint8Array(15)

/** 5枚ハンドを直接 24bit キーに評価する（evaluate5 と同値、アロケーションなし）。 */
export function key5(cards: readonly Card[]): number {
  const c0 = cards[0], c1 = cards[1], c2 = cards[2], c3 = cards[3], c4 = cards[4]
  const isFlush =
    c0.suit === c1.suit && c0.suit === c2.suit && c0.suit === c3.suit && c0.suit === c4.suit

  cnt[c0.rank]++; cnt[c1.rank]++; cnt[c2.rank]++; cnt[c3.rank]++; cnt[c4.rank]++

  // グループ抽出（高ランク優先で走査）
  let quad = 0, trip = 0, pairHi = 0, pairLo = 0
  let k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0
  let uniq = 0, hi = 0, lo = 15
  for (let r = 14; r >= 2; r--) {
    const c = cnt[r]
    if (c === 0) continue
    uniq++
    if (r > hi) hi = r
    if (r < lo) lo = r
    if (c === 4) quad = r
    else if (c === 3) trip = r
    else if (c === 2) {
      if (pairHi === 0) pairHi = r
      else pairLo = r
    } else {
      if (k1 === 0) k1 = r
      else if (k2 === 0) k2 = r
      else if (k3 === 0) k3 = r
      else if (k4 === 0) k4 = r
      else k5 = r
    }
  }
  cnt[c0.rank] = 0; cnt[c1.rank] = 0; cnt[c2.rank] = 0; cnt[c3.rank] = 0; cnt[c4.rank] = 0

  // ストレート判定（5ランクすべて異なる場合のみ）
  let straightHigh = 0
  if (uniq === 5) {
    if (hi - lo === 4) straightHigh = hi
    else if (hi === 14 && k2 === 5) straightHigh = 5 // A-2-3-4-5（k1=14, k2=5, k3=4, k4=3, k5=2）
  }

  if (isFlush && straightHigh) return (HandCategory.StraightFlush << 20) | (straightHigh << 16)
  if (quad) return (HandCategory.Quads << 20) | (quad << 16) | (k1 << 12)
  if (trip && pairHi) return (HandCategory.FullHouse << 20) | (trip << 16) | (pairHi << 12)
  if (isFlush) {
    return (
      (HandCategory.Flush << 20) | (k1 << 16) | (k2 << 12) | (k3 << 8) | (k4 << 4) | k5
    )
  }
  if (straightHigh) return (HandCategory.Straight << 20) | (straightHigh << 16)
  if (trip) return (HandCategory.Trips << 20) | (trip << 16) | (k1 << 12) | (k2 << 8)
  if (pairLo) return (HandCategory.TwoPair << 20) | (pairHi << 16) | (pairLo << 12) | (k1 << 8)
  if (pairHi) {
    return (HandCategory.Pair << 20) | (pairHi << 16) | (k1 << 12) | (k2 << 8) | (k3 << 4)
  }
  return (HandCategory.HighCard << 20) | (k1 << 16) | (k2 << 12) | (k3 << 8) | (k4 << 4) | k5
}

/** 3枚（top）ハンドを直接 24bit キーに評価する（evaluate3 と同値）。 */
export function key3(cards: readonly Card[]): number {
  const a = cards[0].rank, b = cards[1].rank, c = cards[2].rank
  if (a === b && b === c) return (HandCategory.Trips << 20) | (a << 16)
  if (a === b) return (HandCategory.Pair << 20) | (a << 16) | (c << 12)
  if (a === c) return (HandCategory.Pair << 20) | (a << 16) | (b << 12)
  if (b === c) return (HandCategory.Pair << 20) | (b << 16) | (a << 12)
  // ハイカード: 3ランクを降順に
  let x: number = a, y: number = b, z: number = c, t = 0
  if (x < y) { t = x; x = y; y = t }
  if (y < z) { t = y; y = z; z = t }
  if (x < y) { t = x; x = y; y = t }
  return (HandCategory.HighCard << 20) | (x << 16) | (y << 12) | (z << 8)
}

// --- キーからのロイヤリティ（royalties.ts と同じ標準表。クロスチェックテストで同値性を担保） ---

const BOTTOM_ROY = new Int8Array(9)
BOTTOM_ROY[HandCategory.Straight] = 2
BOTTOM_ROY[HandCategory.Flush] = 4
BOTTOM_ROY[HandCategory.FullHouse] = 6
BOTTOM_ROY[HandCategory.Quads] = 10
BOTTOM_ROY[HandCategory.StraightFlush] = 15

const MIDDLE_ROY = new Int8Array(9)
MIDDLE_ROY[HandCategory.Trips] = 2
MIDDLE_ROY[HandCategory.Straight] = 4
MIDDLE_ROY[HandCategory.Flush] = 8
MIDDLE_ROY[HandCategory.FullHouse] = 12
MIDDLE_ROY[HandCategory.Quads] = 20
MIDDLE_ROY[HandCategory.StraightFlush] = 30

const ROYAL_KEY = (HandCategory.StraightFlush << 20) | (14 << 16)

export function royaltyBottomKey(key: number): number {
  if (key === ROYAL_KEY) return 25
  return BOTTOM_ROY[key >>> 20]
}

export function royaltyMiddleKey(key: number): number {
  if (key === ROYAL_KEY) return 50
  return MIDDLE_ROY[key >>> 20]
}

export function royaltyTopKey(key: number): number {
  const cat = key >>> 20
  if (cat === HandCategory.Trips) return 10 + ((key >>> 16) & 0xf) - 2
  if (cat === HandCategory.Pair) {
    const pairRank = (key >>> 16) & 0xf
    return pairRank >= 6 ? pairRank - 5 : 0
  }
  return 0
}

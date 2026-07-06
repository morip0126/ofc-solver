import { describe, expect, it } from 'vitest'
import { type Card, JOKER_CARDS, cardId, cardsToString, makeDeck } from './cards'
import { combinations, mulberry32, shuffle } from './combinatorics'
import { evaluate3, evaluate5 } from './evaluator'
import { key3, key5, packHandValue } from './fastEval'

// ジョーカー（ワイルド）評価のクロスチェック。
//
// 1. 全数検証: key5Wild の直接構成 vs 「52枚置換の総当たり max」（key5 の自然パスを使う独立実装）。
//    1ジョーカー = C(52,4) 全手、2ジョーカー = C(52,3) 全手を検証する。
// 2. 参照実装（evaluator.ts の置換総当たり）とのランダム突き合わせ。

/** 置換総当たりによる最強キー（独立のブルートフォース実装）。 */
function bruteWildKey5(naturals: readonly Card[]): number {
  const present = new Set(naturals.map(cardId))
  const subs = makeDeck().filter((c) => !present.has(cardId(c)))
  const buf: Card[] = naturals.slice()
  buf.length = 5
  let best = -1
  if (naturals.length === 4) {
    for (const s of subs) {
      buf[4] = s
      const k = key5(buf)
      if (k > best) best = k
    }
  } else {
    for (let i = 0; i < subs.length; i++) {
      for (let k2 = i + 1; k2 < subs.length; k2++) {
        buf[3] = subs[i]
        buf[4] = subs[k2]
        const k = key5(buf)
        if (k > best) best = k
      }
    }
  }
  return best
}

describe('key5 with jokers', () => {
  it('matches brute-force substitution on ALL 1-joker hands (C(52,4))', () => {
    const deck = makeDeck()
    for (const naturals of combinations(deck, 4)) {
      const hand = [...naturals, JOKER_CARDS[0]]
      const fast = key5(hand)
      const brute = bruteWildKey5(naturals)
      if (fast !== brute) {
        expect.fail(
          `mismatch for ${cardsToString(hand)}: fast=${fast.toString(16)} brute=${brute.toString(16)}`,
        )
      }
    }
  }, 240_000)

  it('matches brute-force substitution on ALL 2-joker hands (C(52,3))', () => {
    const deck = makeDeck()
    for (const naturals of combinations(deck, 3)) {
      const hand = [...naturals, JOKER_CARDS[0], JOKER_CARDS[1]]
      const fast = key5(hand)
      const brute = bruteWildKey5(naturals)
      if (fast !== brute) {
        expect.fail(
          `mismatch for ${cardsToString(hand)}: fast=${fast.toString(16)} brute=${brute.toString(16)}`,
        )
      }
    }
  }, 240_000)

  it('joker position does not matter', () => {
    const deck = makeDeck()
    const rng = mulberry32(0x11f)
    for (let i = 0; i < 2000; i++) {
      shuffle(deck, rng)
      const naturals = deck.slice(0, 4)
      const hand = [...naturals, JOKER_CARDS[0]]
      const ref = key5(hand)
      for (let pos = 0; pos < 4; pos++) {
        const permuted = hand.slice()
        ;[permuted[pos], permuted[4]] = [permuted[4], permuted[pos]]
        expect(key5(permuted)).toBe(ref)
      }
    }
  })

  it('matches the evaluator reference (substitution over evaluate5) on random hands', () => {
    const deck = makeDeck()
    const rng = mulberry32(0x77a)
    for (let i = 0; i < 3000; i++) {
      shuffle(deck, rng)
      const one = [...deck.slice(0, 4), JOKER_CARDS[0]]
      expect(key5(one)).toBe(packHandValue(evaluate5(one)))
      const two = [...deck.slice(4, 7), JOKER_CARDS[0], JOKER_CARDS[1]]
      expect(key5(two)).toBe(packHandValue(evaluate5(two)))
    }
  })
})

describe('key3 with jokers', () => {
  it('matches the evaluator reference on ALL 1-joker and 2-joker tops', () => {
    const deck = makeDeck()
    for (const naturals of combinations(deck, 2)) {
      const hand = [...naturals, JOKER_CARDS[0]]
      expect(key3(hand)).toBe(packHandValue(evaluate3(hand)))
    }
    for (const natural of deck) {
      const hand = [natural, JOKER_CARDS[0], JOKER_CARDS[1]]
      expect(key3(hand)).toBe(packHandValue(evaluate3(hand)))
    }
  }, 120_000)
})

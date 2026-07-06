import { describe, it, expect } from 'vitest'
import { makeDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { compareHand, evaluate3, evaluate5 } from './evaluator'
import { royaltyBottom, royaltyMiddle, royaltyTop } from './royalties'
import {
  key3,
  key5,
  packHandValue,
  royaltyBottomKey,
  royaltyMiddleKey,
  royaltyTopKey,
  unpackHandValue,
} from './fastEval'

// 高速パスは参照実装（evaluator.ts / royalties.ts）とのクロスチェックで正しさを担保する。

describe('fastEval cross-check vs reference implementation', () => {
  const rng = mulberry32(0xC0FFEE)
  const deck = makeDeck()

  it('key5 === pack(evaluate5) and royalties match on random 5-card hands', () => {
    for (let i = 0; i < 20000; i++) {
      shuffle(deck, rng)
      const cards = deck.slice(0, 5)
      const ref = evaluate5(cards)
      const key = key5(cards)
      expect(key).toBe(packHandValue(ref))
      expect(royaltyBottomKey(key)).toBe(royaltyBottom(ref))
      expect(royaltyMiddleKey(key)).toBe(royaltyMiddle(ref))
      expect(unpackHandValue(key)).toEqual(ref)
    }
  })

  it('key3 === pack(evaluate3) and top royalties match on random 3-card hands', () => {
    for (let i = 0; i < 20000; i++) {
      shuffle(deck, rng)
      const cards = deck.slice(0, 3)
      const ref = evaluate3(cards)
      const key = key3(cards)
      expect(key).toBe(packHandValue(ref))
      expect(royaltyTopKey(key)).toBe(royaltyTop(ref))
      expect(unpackHandValue(key)).toEqual(ref)
    }
  })

  it('integer key order matches compareHand incl. truncated top-vs-middle semantics', () => {
    for (let i = 0; i < 20000; i++) {
      shuffle(deck, rng)
      const five = deck.slice(0, 5)
      const three = deck.slice(5, 8)
      const kFive = key5(five)
      const kThree = key3(three)
      const cmp = compareHand(evaluate5(five), evaluate3(three))
      // ファウル判定は「middle < top なら反則」。0埋めパックでは、切り詰め比較で
      // タイになるケースは kFive >= kThree 側に倒れるため、middle<top の判定は一致する。
      expect(kFive < kThree).toBe(cmp < 0)
    }
  })

  it('integer key order matches compareHand for same-size hands', () => {
    for (let i = 0; i < 20000; i++) {
      shuffle(deck, rng)
      const a = deck.slice(0, 5)
      const b = deck.slice(5, 10)
      const cmp = compareHand(evaluate5(a), evaluate5(b))
      const ka = key5(a)
      const kb = key5(b)
      expect(Math.sign(ka - kb)).toBe(cmp)
    }
  })
})

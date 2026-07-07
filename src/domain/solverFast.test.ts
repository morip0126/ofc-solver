import { describe, it, expect } from 'vitest'
import { type Card, makeDeck, parseCards, without } from './cards'
import { combinations, mulberry32, shuffle } from './combinatorics'
import type { Arrangement } from './score'
import {
  evaluateArrangement,
  fantasylandCards,
  royaltiesTotal,
  scoreEvaluated,
  scoreMultiEvaluated,
} from './score'
import { NORMAL, ULTIMATE } from './variants'
import type { Variant } from './variants'
import { key3, key5, royaltyBottomKey, royaltyMiddleKey, royaltyTopKey } from './fastEval'
import { estimateEVvsRandom, solveBest13, solveFantasyland } from './solver'

// 高速化した solveBest13 / solveFantasyland を、素朴な参照実装（combinations +
// evaluateArrangement の全列挙）とクロスチェックする。

function referenceBestObjective(cards: readonly Card[], variant: Variant, flBonus: number): number {
  let best = -1
  for (const top of combinations(cards, 3)) {
    const rest10 = without(cards, top)
    for (const middle of combinations(rest10, 5)) {
      const bottom = without(rest10, middle)
      const arrangement: Arrangement = { top, middle, bottom }
      const evaluated = evaluateArrangement(arrangement)
      if (evaluated.fouled) continue
      const obj =
        royaltiesTotal(evaluated) + (fantasylandCards(evaluated, variant) > 0 ? flBonus : 0)
      if (obj > best) best = obj
    }
  }
  return best
}

describe('solveBest13 (fast) vs reference brute force', () => {
  it('finds the same best objective on random 13-card hands', () => {
    const rng = mulberry32(777)
    const deck = makeDeck()
    for (let i = 0; i < 10; i++) {
      shuffle(deck, rng)
      const hand = deck.slice(0, 13)
      for (const flBonus of [0, 8]) {
        const fast = solveBest13(hand, NORMAL, { topK: 1, fantasylandBonus: flBonus })[0]
        const ref = referenceBestObjective(hand, NORMAL, flBonus)
        const fastObj =
          fast.royalties + (fast.fantasylandCards > 0 ? flBonus : 0)
        expect(fast.evaluated.fouled).toBe(false)
        expect(fastObj).toBe(ref)
      }
    }
  })

  it('finds the same best royalties on joker-deck 13-card hands (key-based reference)', () => {
    // 探索（枝刈り・列挙）の正しさ検証。行評価のワイルド同値性は fastEvalWild.test.ts で
    // 全数証明済みなので、ここではキーベースの素朴な全列挙を参照にする。
    const rng = mulberry32(778)
    const deck = makeDeck(true)
    for (let i = 0; i < 6; i++) {
      shuffle(deck, rng)
      const hand = deck.slice(0, 13)
      const want = i % 2 === 0 ? 2 : 1
      for (let w = 0; w < want; w++) {
        const j = { rank: 0, suit: w === 0 ? 'c' : 'd' } as Card
        if (hand.some((c) => c.rank === 0 && c.suit === j.suit)) continue
        let slot = 0
        while (hand[slot].rank === 0) slot++
        hand[slot] = j
      }
      const fast = solveBest13(hand, NORMAL, { topK: 1 })[0]
      const ref = referenceBestRoyaltiesByKeys(hand)
      expect(fast.evaluated.fouled).toBe(false)
      expect(fast.royalties).toBe(ref)
    }
  })

  it('matches the full evaluator reference on a 1-joker hand', () => {
    // 置換総当たりの参照実装（evaluator.ts）との突き合わせは重いので1ハンドに絞る。
    const rng = mulberry32(779)
    const deck = makeDeck()
    shuffle(deck, rng)
    const hand = [...deck.slice(0, 12), { rank: 0, suit: 'c' } as Card]
    const fast = solveBest13(hand, NORMAL, { topK: 1 })[0]
    const ref = referenceBestObjective(hand, NORMAL, 0)
    expect(fast.evaluated.fouled).toBe(false)
    expect(fast.royalties).toBe(ref)
  }, 120_000)
})

/** キーベースの素朴な全列挙（ワイルド対応の key3/key5/royalty*Key を使う参照）。 */
function referenceBestRoyaltiesByKeys(cards: readonly Card[]): number {
  let best = -1
  for (const top of combinations(cards, 3)) {
    const kT = key3(top)
    const rest10 = without(cards, top)
    for (const middle of combinations(rest10, 5)) {
      const kM = key5(middle)
      if (kM < kT) continue
      const bottom = without(rest10, middle)
      const kB = key5(bottom)
      if (kB < kM) continue
      const roys = royaltyBottomKey(kB) + royaltyMiddleKey(kM) + royaltyTopKey(kT)
      if (roys > best) best = roys
    }
  }
  return best
}

describe('solveFantasyland', () => {
  it('matches leave-one-out solveBest13 on 14-card hands', () => {
    const rng = mulberry32(4242)
    const deck = makeDeck()
    for (let i = 0; i < 3; i++) {
      shuffle(deck, rng)
      const hand = deck.slice(0, 14)
      // 参照: どの1枚を除いても、13枚の最善（stayBonus 込み目的値）の最大値と一致するはず。
      let ref = -1
      const stayBonus = 6
      for (let skip = 0; skip < 14; skip++) {
        const thirteen = hand.filter((_, k) => k !== skip)
        for (const top of combinations(thirteen, 3)) {
          const rest10 = without(thirteen, top)
          for (const middle of combinations(rest10, 5)) {
            const bottom = without(rest10, middle)
            const evaluated = evaluateArrangement({ top, middle, bottom })
            if (evaluated.fouled) continue
            const stays = NORMAL.fantasylandStay(evaluated.top, evaluated.middle, evaluated.bottom)
            const obj = royaltiesTotal(evaluated) + (stays ? stayBonus : 0)
            if (obj > ref) ref = obj
          }
        }
      }
      const fast = solveFantasyland(hand, NORMAL, { stayBonus, topK: 1 })[0]
      expect(fast.evaluated.fouled).toBe(false)
      expect(fast.objective).toBe(ref)
    }
  })

  it('keeps trips on top for a hand that can stay in fantasyland', () => {
    // AAA を top に置けばリステイ + トップロイヤリティ22 が取れる強い14枚。
    const cards = parseCards('Ah Ac Ad Ks Kh Kd Qs Qh 9c 8c 7c 6c 5c 2d')
    const best = solveFantasyland(cards, ULTIMATE, { stayBonus: 6, topK: 1 })[0]
    expect(best.stays).toBe(true)
    // AAA top(22) + 9-5 の c ストレートフラッシュ bottom(15) + KKQQx middle(0) + stay
    expect(best.royalties).toBeGreaterThanOrEqual(22 + 15)
  })

  it('handles 17 cards within a reasonable time', () => {
    const rng = mulberry32(99)
    const deck = makeDeck()
    shuffle(deck, rng)
    const hand = deck.slice(0, 17)
    const t0 = performance.now()
    const results = solveFantasyland(hand, ULTIMATE, { topK: 3 })
    const elapsed = performance.now() - t0
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].evaluated.fouled).toBe(false)
    // 全探索でも Worker で待てる時間に収まること（緩めの上限）。
    expect(elapsed).toBeLessThan(15000)
  }, 20000)
})

describe('scoreMultiEvaluated', () => {
  it('is zero-sum and consistent with pairwise scores for 3 players', () => {
    const a = evaluateArrangement({
      top: makeHand('Ah Ac Ad'),
      middle: makeHand('Ks Kh Kd Qs Qh'),
      bottom: makeHand('5s 6s 7s 8s 9s'),
    })
    const b = evaluateArrangement({
      top: makeHand('2h 3c 4d'),
      middle: makeHand('5h 6h 7h 8h Th'),
      bottom: makeHand('9c Tc Jc Qc Kc'),
    })
    const c = evaluateArrangement({
      top: makeHand('Kh Qd Jd'),
      middle: makeHand('2s 2c 3s 3h 4c'),
      bottom: makeHand('7d 7h 8d 8s 4h'),
    })
    const totals = scoreMultiEvaluated([a, b, c], NORMAL)
    expect(totals[0] + totals[1] + totals[2]).toBe(0)
    const ab = scoreEvaluated(a, b, NORMAL)
    const ac = scoreEvaluated(a, c, NORMAL)
    const bc = scoreEvaluated(b, c, NORMAL)
    expect(totals[0]).toBe(ab + ac)
    expect(totals[1]).toBe(-ab + bc)
    expect(totals[2]).toBe(-ac - bc)
  })
})

describe('estimateEVvsRandom with multiple opponents', () => {
  it('a monster hand earns roughly twice as much against two opponents', () => {
    const monster: Arrangement = {
      top: makeHand('Ah Ac Ad'),
      middle: makeHand('Ks Kh Kd Qs Qh'),
      bottom: makeHand('5s 6s 7s 8s 9s'),
    }
    const ev1 = estimateEVvsRandom(monster, [], NORMAL, { iters: 24, rng: mulberry32(5) })
    const ev2 = estimateEVvsRandom(monster, [], NORMAL, {
      iters: 24,
      rng: mulberry32(5),
      opponents: 2,
    })
    expect(ev1).toBeGreaterThan(0)
    expect(ev2).toBeGreaterThan(ev1 * 1.3)
  })
})

function makeHand(codes: string): Card[] {
  return parseCards(codes)
}

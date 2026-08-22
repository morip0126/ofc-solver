// 種類別（アルティメット / プログレッシブ × 52枚 / 54枚）の実プレー統計計測ランナー。
// 通常ハンド→FL突入→リステイ連鎖まで含むライフサイクルを現在の実装（推奨手#1採用）で回す。
// 手動実行用（通常の `pnpm test` ではスキップ）:
//
//   VARIANT_STATS_HANDS=400 pnpm vitest run src/domain/variantStats.test.ts --testTimeout=14400000
//
// 相手モデルは flValueRate.test.ts と同じ（残りデッキからランダム13枚をロイヤリティ最善配置）。

import { describe, it } from 'vitest'
import { type Card, makeDeck, remainingDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import {
  type Arrangement,
  type EvaluatedArrangement,
  evaluateArrangement,
  fantasylandCards,
  scoreEvaluated,
} from './score'
import { type Board, solveBest13, solveFantasyland, stayBonusFor, suggestInitial5, suggestStreet } from './solver'
import { PROGRESSIVE, ULTIMATE, type Variant } from './variants'

const HANDS = Number(process.env.VARIANT_STATS_HANDS ?? 0)

function scoreVsOpponents(
  hero: EvaluatedArrangement,
  seen: readonly Card[],
  jokers: boolean,
  rng: () => number,
  k: number,
): number {
  const deck = remainingDeck(seen, jokers)
  let sum = 0
  for (let i = 0; i < k; i++) {
    shuffle(deck, rng)
    const opp = solveBest13(deck.slice(0, 13), ULTIMATE, { topK: 1 })[0].evaluated
    sum += scoreEvaluated(hero, opp, ULTIMATE)
  }
  return sum / k
}

function runConfig(variant: Variant, jokers: boolean, hands: number, seed: number): void {
  const label = `${variant.id} / ${jokers ? '54枚+ジョーカー2' : '52枚'}`
  const rng = mulberry32(seed)
  const deck = makeDeck(jokers)

  let pendingFL = 0
  let sum = 0
  let sum2 = 0
  let normalHands = 0
  let normalSum = 0
  let fouls = 0
  let flHands = 0
  let flSum = 0
  let stays = 0
  const entries: Record<number, number> = { 14: 0, 15: 0, 16: 0, 17: 0 }
  const flPlayed: Record<number, number> = { 14: 0, 15: 0, 16: 0, 17: 0 }
  const t0 = Date.now()

  for (let h = 0; h < hands; h++) {
    shuffle(deck, rng)
    let sc: number
    if (pendingFL > 0) {
      const n = pendingFL
      flHands++
      flPlayed[n]++
      const cards = deck.slice(0, n)
      const best = solveFantasyland(cards, variant, {
        stayBonus: stayBonusFor(n, jokers, variant),
        topK: 1,
      })[0]
      if (!best) {
        sc = -6
        pendingFL = 0
      } else {
        sc = scoreVsOpponents(best.evaluated, cards, jokers, rng, 6)
        if (best.stays) {
          stays++
          pendingFL = variant.restayKeepsCount ? n : 14
        } else {
          pendingFL = 0
        }
      }
      flSum += sc
    } else {
      normalHands++
      let board: Board = suggestInitial5(deck.slice(0, 5), [], variant, {
        iters: 64,
        refineTopK: 8,
        jokers,
        rng,
        futureModel: 'streets',
      })[0].board
      const discards: Card[] = []
      for (let s = 0; s < 4; s++) {
        const drawn = deck.slice(5 + 3 * s, 8 + 3 * s)
        const best = suggestStreet(board, drawn, discards, variant, {
          iters: 96,
          jokers,
          rng,
          futureModel: 'streets',
        })[0]
        board = best.board
        if (best.discarded) discards.push(best.discarded)
      }
      const final = evaluateArrangement(board as Arrangement)
      if (final.fouled) fouls++
      else {
        const fc = fantasylandCards(final, variant)
        if (fc > 0) {
          entries[fc] = (entries[fc] ?? 0) + 1
          pendingFL = fc
        }
      }
      const seen = [...board.top, ...board.middle, ...board.bottom, ...discards]
      sc = scoreVsOpponents(final, seen, jokers, rng, 8)
      normalSum += sc
    }
    sum += sc
    sum2 += sc * sc
    if ((h + 1) % 100 === 0) {
      console.log(`[${label}] ... ${h + 1}/${hands} (${Math.round((Date.now() - t0) / 1000)}s)`)
    }
  }

  const mean = sum / hands
  const se = Math.sqrt(Math.max(0, sum2 / hands - mean * mean) / hands)
  const totalEntries = entries[14] + entries[15] + entries[16] + entries[17]
  const pct = (x: number, base: number) => (base > 0 ? ((100 * x) / base).toFixed(1) : '0.0')
  console.log(`[${label}] ===== 結果 (${hands}ハンド, ${Math.round((Date.now() - t0) / 1000)}s) =====`)
  console.log(
    `[${label}] 平均得点/ハンド μ = ${mean.toFixed(2)} ±${se.toFixed(2)} ` +
      `(通常 ${normalHands}ハンド: ${(normalSum / Math.max(1, normalHands)).toFixed(2)}, ` +
      `FL ${flHands}ハンド: ${(flSum / Math.max(1, flHands)).toFixed(2)})`,
  )
  console.log(
    `[${label}] 通常ハンド: ファウル ${pct(fouls, normalHands)}% ` +
      `FL突入 ${pct(totalEntries, normalHands)}% ` +
      `(14:${pct(entries[14], normalHands)}% 15:${pct(entries[15], normalHands)}% ` +
      `16:${pct(entries[16], normalHands)}% 17:${pct(entries[17], normalHands)}%)`,
  )
  console.log(
    `[${label}] FLハンド: 全体の ${pct(flHands, hands)}% ` +
      `(枚数内訳 14:${flPlayed[14]} 15:${flPlayed[15]} 16:${flPlayed[16]} 17:${flPlayed[17]}) ` +
      `リステイ率 ${pct(stays, flHands)}%`,
  )
}

describe('variant lifecycle stats (set VARIANT_STATS_HANDS to run)', () => {
  it.skipIf(HANDS <= 0)('ultimate / 52-card', () => {
    runConfig(ULTIMATE, false, HANDS, 0xa152)
  }, 14_400_000)

  it.skipIf(HANDS <= 0)('ultimate / 54-card joker', () => {
    runConfig(ULTIMATE, true, HANDS, 0xa154)
  }, 14_400_000)

  it.skipIf(HANDS <= 0)('progressive / 52-card', () => {
    runConfig(PROGRESSIVE, false, HANDS, 0xb152)
  }, 14_400_000)

  it.skipIf(HANDS <= 0)('progressive / 54-card joker', () => {
    runConfig(PROGRESSIVE, true, HANDS, 0xb154)
  }, 14_400_000)
})

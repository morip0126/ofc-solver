// FL 価値（DEFAULT_FL_VALUES）導出用の計測ランナー（手動実行用。通常の `pnpm test` ではスキップ）。
//
//   FL_VALUE_HANDS=500 pnpm vitest run src/domain/flValueRate.test.ts --testTimeout=7200000
//
// solver.ts の DEFAULT_FL_VALUES と同じ方法論:
//   - 相手モデル: 残りデッキからランダム13枚をロイヤリティ最善配置（solveBest13）
//   - S_N: 通常ハンドのヒューリスティック逐次プレイ（suggestInitial5 → suggestStreet ×4）の期待得点
//   - S_FL(n): n枚 FL を solveFantasyland で打った期待得点
//   - Δ(n) = S_FL(n) − S_N,  V(n) = Δ(n)/(1 − pStay(n))
//     （同枚数維持リステイのルームルール。リステイ→14枚の標準ルールなら
//       V(14)=Δ(14)/(1−p14), V(n)=Δ(n)+pStay(n)・V(14)）
// pStay は flStayRate.test.ts の100万ハンド実測値を使う。
// 相手モデル依存の項は Δ で相殺される。ジョーカーの有無それぞれで計測できる。

import { describe, it } from 'vitest'
import { type Card, makeDeck, remainingDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { type Arrangement, type EvaluatedArrangement, evaluateArrangement, scoreEvaluated } from './score'
import {
  type Board,
  DEFAULT_STAY_BONUS,
  solveBest13,
  solveFantasyland,
  suggestInitial5,
  suggestStreet,
} from './solver'
import { ULTIMATE } from './variants'

const HANDS = Number(process.env.FL_VALUE_HANDS ?? 0)

// S_N 単体の再計測（重み反復の収束確認用）。FL価値テーブルを更新した後にこれで S_N を測り直し、
// V の再計算値が現行テーブルと大きくずれないこと（±1点程度）を確認する。
const SN_HANDS = Number(process.env.FL_VALUE_SN_HANDS ?? 0)

// flStayRate.test.ts の 100万ハンド実測（95%CI ±0.1%）。
const P_STAY: Record<'52' | '54', Record<number, number>> = {
  '52': { 14: 0.1054, 15: 0.1945, 16: 0.3465, 17: 0.5484 },
  '54': { 14: 0.3772, 15: 0.4967, 16: 0.639, 17: 0.7771 },
}

interface Stat {
  mean: number
  se: number
  n: number
}

function makeAccumulator() {
  let sum = 0
  let sum2 = 0
  let n = 0
  return {
    add(x: number) {
      sum += x
      sum2 += x * x
      n++
    },
    stat(): Stat {
      const mean = sum / n
      const varr = sum2 / n - mean * mean
      return { mean, se: Math.sqrt(Math.max(0, varr) / n), n }
    },
  }
}

/**
 * 相手モデル: 残りデッキからランダム13枚をロイヤリティ最善配置。
 * 相手ドロー由来の分散を抑えるため、k 回ドローした得点の平均を返す（期待値は不変）。
 */
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

/** 通常ハンドのヒューリスティック逐次プレイ（実戦アシスタントの推奨手 #1 を採用し続ける）。 */
function measureSN(jokers: boolean, hands: number, seed: number): Stat & { foulRate: number } {
  const rng = mulberry32(seed)
  const deck = makeDeck(jokers)
  const acc = makeAccumulator()
  let fouls = 0
  for (let h = 0; h < hands; h++) {
    shuffle(deck, rng)
    let board: Board = suggestInitial5(deck.slice(0, 5), [], ULTIMATE, {
      iters: 64,
      refineTopK: 8,
      jokers,
      rng,
    })[0].board
    const discards: Card[] = []
    for (let s = 0; s < 4; s++) {
      const drawn = deck.slice(5 + 3 * s, 8 + 3 * s)
      const best = suggestStreet(board, drawn, discards, ULTIMATE, { iters: 96, jokers, rng })[0]
      board = best.board
      if (best.discarded) discards.push(best.discarded)
    }
    const final = evaluateArrangement(board as Arrangement)
    if (final.fouled) fouls++
    const seen = [...board.top, ...board.middle, ...board.bottom, ...discards]
    acc.add(scoreVsOpponents(final, seen, jokers, rng, 8))
  }
  return { ...acc.stat(), foulRate: fouls / hands }
}

/** n枚 FL を solveFantasyland で打つ。 */
function measureSFL(
  n: number,
  jokers: boolean,
  hands: number,
  stayBonus: number,
  seed: number,
): Stat & { stayRate: number } {
  const rng = mulberry32(seed)
  const deck = makeDeck(jokers)
  const acc = makeAccumulator()
  let stays = 0
  for (let h = 0; h < hands; h++) {
    shuffle(deck, rng)
    const cards = deck.slice(0, n)
    const best = solveFantasyland(cards, ULTIMATE, { stayBonus, topK: 1 })[0]
    if (!best) {
      acc.add(-6) // 非ファウル配置なし（実質起こらない）: ファウル扱い
      continue
    }
    if (best.stays) stays++
    acc.add(scoreVsOpponents(best.evaluated, cards, jokers, rng, 6))
  }
  return { ...acc.stat(), stayRate: stays / hands }
}

function fmt(s: Stat): string {
  return `${s.mean.toFixed(2)} ±${s.se.toFixed(2)} (n=${s.n})`
}

function runDeck(jokers: boolean, stayBonus: number): void {
  const label = jokers ? '54枚+ジョーカー2' : '52枚'
  const pStay = P_STAY[jokers ? '54' : '52']
  const t0 = Date.now()

  const sn = measureSN(jokers, HANDS, jokers ? 0x54aa : 0x52aa)
  console.log(`[${label}] S_N = ${fmt(sn)} foul=${(100 * sn.foulRate).toFixed(1)}% (${Math.round((Date.now() - t0) / 1000)}s)`)

  const sfl: Record<number, Stat & { stayRate: number }> = {}
  const SFL_HANDS: Record<number, number> = {
    14: 3 * HANDS,
    15: 2 * HANDS,
    16: Math.round(1.2 * HANDS),
    17: Math.round(0.8 * HANDS),
  }
  for (let n = 14; n <= 17; n++) {
    const t = Date.now()
    sfl[n] = measureSFL(n, jokers, SFL_HANDS[n], stayBonus, (jokers ? 0x54f0 : 0x52f0) + n)
    console.log(
      `[${label}] S_FL(${n}) = ${fmt(sfl[n])} stay=${(100 * sfl[n].stayRate).toFixed(1)}% ` +
        `(${Math.round((Date.now() - t) / 1000)}s)`,
    )
  }

  // 価値の連鎖（同枚数維持リステイ）: V(n) = Δ(n)/(1 − pStay(n))
  const delta: Record<number, number> = {}
  for (let n = 14; n <= 17; n++) delta[n] = sfl[n].mean - sn.mean
  console.log(
    `[${label}] Δ={14:${delta[14].toFixed(2)}, 15:${delta[15].toFixed(2)}, 16:${delta[16].toFixed(2)}, 17:${delta[17].toFixed(2)}}`,
  )
  const v = (n: number) => delta[n] / (1 - pStay[n])
  console.log(
    `[${label}] V={14:${v(14).toFixed(1)}, 15:${v(15).toFixed(1)}, 16:${v(16).toFixed(1)}, 17:${v(17).toFixed(1)}} (stayBonus=${stayBonus}で計測)`,
  )
}

describe('FL value measurement (set FL_VALUE_HANDS to run)', () => {
  it.skipIf(HANDS <= 0)('52-card deck (methodology check vs documented values)', () => {
    runDeck(false, DEFAULT_STAY_BONUS)
  }, 7_200_000)

  it.skipIf(HANDS <= 0)('54-card joker deck', () => {
    runDeck(true, 20)
  }, 7_200_000)

  it.skipIf(SN_HANDS <= 0)('54-card joker deck: S_N re-measurement (iteration check)', () => {
    // 現在ソルバーに入っている FL 価値テーブルでの通常ハンド成績。反復ごとにシードを変える。
    const sn = measureSN(true, SN_HANDS, 0x54ab)
    console.log(
      `[54枚+ジョーカー2] S_N(再計測) = ${sn.mean.toFixed(2)} ±${sn.se.toFixed(2)} (n=${sn.n}) ` +
        `foul=${(100 * sn.foulRate).toFixed(1)}%`,
    )
  }, 7_200_000)
})

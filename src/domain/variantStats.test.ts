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
  royaltiesTotal,
  scoreEvaluated,
} from './score'
import {
  type Board,
  DEFAULT_FL_VALUES,
  DEFAULT_FL_VALUES_JOKER,
  PROGRESSIVE_FL_VALUES,
  PROGRESSIVE_FL_VALUES_JOKER,
  solveBest13,
  solveFantasyland,
  stayBonusFor,
  suggestInitial5,
  suggestStreet,
} from './solver'
import { PROGRESSIVE, ULTIMATE, type Variant } from './variants'

const HANDS = Number(process.env.VARIANT_STATS_HANDS ?? 0)

// FLチェイス度のA/B: 通常ハンドの候補評価に使うFL価値を flScale 倍に水増しして、
// 突入率と総合μがどう動くかを見る（FL中のプレー・リステイボーナスは変えない）。
const CHASE_HANDS = Number(process.env.FL_CHASE_HANDS ?? 0)

// 探索精度のA/B: 重みは据え置きで、試行回数・未来モデルだけ上げて突入率とμがどう動くかを見る。
const PRECISION_HANDS = Number(process.env.FL_PRECISION_HANDS ?? 0)

// 精度スケーリング: streets のまま 8倍/16倍 iters + 高精度×チェイス重みの相互作用。
const PRECISION2_HANDS = Number(process.env.FL_PRECISION2_HANDS ?? 0)

interface PlayPrecision {
  initIters: number
  streetIters: number
  refineTopK: number
  futureModel: 'streets' | 'combined' | 'policy'
}

const LIGHT: PlayPrecision = { initIters: 64, streetIters: 96, refineTopK: 8, futureModel: 'streets' }

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

function runConfig(
  variant: Variant,
  jokers: boolean,
  hands: number,
  seed: number,
  flScale = 1,
  prec: PlayPrecision = LIGHT,
): void {
  const label =
    `${variant.id} / ${jokers ? '54枚+ジョーカー2' : '52枚'}` +
    (flScale !== 1 ? ` / FL価値×${flScale}` : '') +
    (prec !== LIGHT ? ` / ${prec.futureModel} ${prec.initIters}/${prec.streetIters}` : '')
  const baseValues = variant.restayKeepsCount
    ? jokers
      ? DEFAULT_FL_VALUES_JOKER
      : DEFAULT_FL_VALUES
    : jokers
      ? PROGRESSIVE_FL_VALUES_JOKER
      : PROGRESSIVE_FL_VALUES
  const flValues: Record<number, number> = {}
  for (let n = 14; n <= 17; n++) flValues[n] = baseValues[n] * flScale
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
  // 素点 = 自分のロイヤリティ（ファウルは0）。相手に依存しない。
  let royNormal = 0
  let royFL = 0
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
        royFL += best.royalties
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
        iters: prec.initIters,
        refineTopK: prec.refineTopK,
        jokers,
        rng,
        flValues,
        futureModel: prec.futureModel,
      })[0].board
      const discards: Card[] = []
      for (let s = 0; s < 4; s++) {
        const drawn = deck.slice(5 + 3 * s, 8 + 3 * s)
        const best = suggestStreet(board, drawn, discards, variant, {
          iters: prec.streetIters,
          jokers,
          rng,
          flValues,
          futureModel: prec.futureModel,
        })[0]
        board = best.board
        if (best.discarded) discards.push(best.discarded)
      }
      const final = evaluateArrangement(board as Arrangement)
      if (final.fouled) fouls++
      else {
        royNormal += royaltiesTotal(final)
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
    `[${label}] 素点(ロイヤリティ)/ハンド = ${((royNormal + royFL) / hands).toFixed(2)} ` +
      `(通常: ${(royNormal / Math.max(1, normalHands)).toFixed(2)}, ` +
      `FL: ${(royFL / Math.max(1, flHands)).toFixed(2)})`,
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

describe('FL chase A/B (set FL_CHASE_HANDS to run)', () => {
  it.skipIf(CHASE_HANDS <= 0)('ultimate / 54-card joker, FL values x1.3', () => {
    runConfig(ULTIMATE, true, CHASE_HANDS, 0xa154, 1.3)
  }, 14_400_000)

  it.skipIf(CHASE_HANDS <= 0)('ultimate / 54-card joker, FL values x1.6', () => {
    runConfig(ULTIMATE, true, CHASE_HANDS, 0xa154, 1.6)
  }, 14_400_000)

  it.skipIf(CHASE_HANDS <= 0)('ultimate / 52-card, FL values x1.5', () => {
    runConfig(ULTIMATE, false, CHASE_HANDS, 0xa152, 1.5)
  }, 14_400_000)
})

describe('precision A/B (set FL_PRECISION_HANDS to run)', () => {
  it.skipIf(PRECISION_HANDS <= 0)('ultimate / 54-card joker, streets 4x iters', () => {
    runConfig(ULTIMATE, true, PRECISION_HANDS, 0xa154, 1, {
      initIters: 256,
      streetIters: 384,
      refineTopK: 12,
      futureModel: 'streets',
    })
  }, 14_400_000)

  it.skipIf(PRECISION_HANDS <= 0)('ultimate / 54-card joker, combined standard iters', () => {
    runConfig(ULTIMATE, true, PRECISION_HANDS, 0xa154, 1, {
      initIters: 100,
      streetIters: 130,
      refineTopK: 8,
      futureModel: 'combined',
    })
  }, 14_400_000)
})

describe('precision scaling (set FL_PRECISION2_HANDS to run)', () => {
  it.skipIf(PRECISION2_HANDS <= 0)('ultimate / 54-card joker, streets 8x iters', () => {
    runConfig(ULTIMATE, true, PRECISION2_HANDS, 0xa154, 1, {
      initIters: 512,
      streetIters: 768,
      refineTopK: 16,
      futureModel: 'streets',
    })
  }, 14_400_000)

  it.skipIf(PRECISION2_HANDS <= 0)('ultimate / 54-card joker, streets 16x iters', () => {
    runConfig(ULTIMATE, true, PRECISION2_HANDS, 0xa154, 1, {
      initIters: 1024,
      streetIters: 1536,
      refineTopK: 16,
      futureModel: 'streets',
    })
  }, 14_400_000)

  it.skipIf(PRECISION2_HANDS <= 0)('ultimate / 54-card joker, streets 4x iters + FL values x1.3', () => {
    runConfig(ULTIMATE, true, PRECISION2_HANDS, 0xa154, 1.3, {
      initIters: 256,
      streetIters: 384,
      refineTopK: 12,
      futureModel: 'streets',
    })
  }, 14_400_000)

  // 初手配置の精選別幅を広げる（コース選別で良いFLルートが落ちていないかの検証）。
  it.skipIf(PRECISION2_HANDS <= 0)('ultimate / 54-card joker, streets 4x iters + wide refine', () => {
    runConfig(ULTIMATE, true, PRECISION2_HANDS, 0xa154, 1, {
      initIters: 256,
      streetIters: 384,
      refineTopK: 48,
      futureModel: 'streets',
    })
  }, 14_400_000)
})

// プレーの判断モデルを policy（参考ソルバーのプレーヤー像 = チェイス寄り逐次）にした自己プレー。
// FL価値は補正済みの正直な既定のまま。目標: 素点・FL率が streets プレーの上限帯（素点14.7 / FL34%）
// を超えるか（参考ソルバー並みの実力への一歩）。
const POLICY_HANDS = Number(process.env.FL_POLICY_HANDS ?? 0)

describe('policy-model play (set FL_POLICY_HANDS to run)', () => {
  it.skipIf(POLICY_HANDS <= 0)('ultimate / 54-card joker, policy 64/96', () => {
    runConfig(ULTIMATE, true, POLICY_HANDS, 0xa154, 1, {
      initIters: 64,
      streetIters: 96,
      refineTopK: 8,
      futureModel: 'policy',
    })
  }, 14_400_000)

  it.skipIf(POLICY_HANDS <= 0)('ultimate / 54-card joker, policy 256/384', () => {
    runConfig(ULTIMATE, true, POLICY_HANDS, 0xa154, 1, {
      initIters: 256,
      streetIters: 384,
      refineTopK: 12,
      futureModel: 'policy',
    })
  }, 14_400_000)
})

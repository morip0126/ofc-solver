// 新旧 FL 価値テーブルの同一配牌ペア比較（CLAUDE.md の重み変更時 EV 検証手順）。
//
//   FL_VALUE_AB_HANDS=1000 pnpm vitest run src/domain/flValueAB.test.ts --testTimeout=7200000
//
// ジョーカー入り（54枚）の通常ハンドを、同じ配牌・同じ推奨手MC乱数・同じ相手ドローで
//   OLD: E_N 補正なしの同枚数維持テーブル（参考ソルバーの価値水準 = VALUES_PREV）
//   NEW: E_N 補正つき不動点テーブル（現行 DEFAULT_FL_VALUES_JOKER）
// の両ポリシーでプレイし、J = 対戦スコア + FL突入時の実測FL価値 のペア差を集計する。
// 配牌運・相手運・MCノイズが相殺され、判断が分かれたハンドの損得だけが残る。
//
// FL価値クレジットに新テーブル自身を使うと循環になり得るため、
//   - 純対戦スコア差（クレジットなし）
//   - FL価値クレジット差
//   - 損益分岐スケール s* = −Δ対戦/ΔFLクレジット（真のFL価値がテーブルの s* 倍を超えていれば NEW が得）
// も出力して頑健性を確認できるようにする。

import { describe, it } from 'vitest'
import { type Card, cardId, makeDeck, remainingDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import {
  type Arrangement,
  type EvaluatedArrangement,
  evaluateArrangement,
  fantasylandCards,
  scoreEvaluated,
} from './score'
import {
  type Board,
  DEFAULT_FL_VALUES_JOKER,
  solveBest13,
  suggestInitial5,
  suggestStreet,
} from './solver'

// 変更前のテーブル（E_N 補正なしの同枚数維持値 = 参考ソルバーの価値水準）。
const VALUES_PREV: Readonly<Record<number, number>> = { 14: 20.4, 15: 36.8, 16: 65.8, 17: 126.1 }
import { ULTIMATE } from './variants'

const HANDS = Number(process.env.FL_VALUE_AB_HANDS ?? 0)
const OPP_DRAWS = 8

interface Played {
  final: EvaluatedArrangement
  flCards: number
  board: Board
}

/** 1ハンドを指定の FL 価値テーブルでプレイ（推奨手 #1 を採用し続ける）。 */
function playHand(
  deal: readonly Card[],
  flValues: Readonly<Record<number, number>>,
  seed: number,
): Played {
  const rng = mulberry32(seed)
  let board: Board = suggestInitial5(deal.slice(0, 5), [], ULTIMATE, {
    iters: 64,
    refineTopK: 8,
    jokers: true,
    flValues,
    futureModel: 'streets',
    rng,
  })[0].board
  const discards: Card[] = []
  for (let s = 0; s < 4; s++) {
    const drawn = deal.slice(5 + 3 * s, 8 + 3 * s)
    const best = suggestStreet(board, drawn, discards, ULTIMATE, {
      iters: 96,
      jokers: true,
      flValues,
      futureModel: 'streets',
      rng,
    })[0]
    board = best.board
    if (best.discarded) discards.push(best.discarded)
  }
  const final = evaluateArrangement(board as Arrangement)
  return { final, flCards: fantasylandCards(final, ULTIMATE), board }
}

function boardsEqual(a: Board, b: Board): boolean {
  const key = (bd: Board) =>
    (['top', 'middle', 'bottom'] as const)
      .map((r) => bd[r].map(cardId).sort((x, y) => x - y).join(','))
      .join('|')
  return key(a) === key(b)
}

describe('FL value A/B paired comparison (set FL_VALUE_AB_HANDS to run)', () => {
  it.skipIf(HANDS <= 0)('joker deck: old (52-card) vs new (joker) FL values', () => {
    const dealRng = mulberry32(0xab54)
    const deck = makeDeck(true)

    let diffHands = 0
    let matchSum = 0
    let matchSum2 = 0
    let creditSum = 0
    let jSum = 0
    let jSum2 = 0
    const stats = { old: { foul: 0, fl: 0 }, new: { foul: 0, fl: 0 } }

    for (let h = 0; h < HANDS; h++) {
      shuffle(deck, dealRng)
      const deal = deck.slice(0, 17)
      const playSeed = 0x9a000 + h
      const oldP = playHand(deal, VALUES_PREV, playSeed)
      const newP = playHand(deal, DEFAULT_FL_VALUES_JOKER, playSeed)

      if (oldP.final.fouled) stats.old.foul++
      if (newP.final.fouled) stats.new.foul++
      if (oldP.flCards > 0) stats.old.fl++
      if (newP.flCards > 0) stats.new.fl++

      let matchDiff = 0
      if (!boardsEqual(oldP.board, newP.board)) {
        diffHands++
        // 相手ドローを共有して対戦スコア差を測る（同一盤面なら差 0 なのでスキップ可能）。
        const oppRng = mulberry32(0xcc000 + h)
        const oppDeck = remainingDeck(deal, true)
        let sum = 0
        for (let k = 0; k < OPP_DRAWS; k++) {
          shuffle(oppDeck, oppRng)
          const opp = solveBest13(oppDeck.slice(0, 13), ULTIMATE, { topK: 1 })[0].evaluated
          sum +=
            scoreEvaluated(newP.final, opp, ULTIMATE) - scoreEvaluated(oldP.final, opp, ULTIMATE)
        }
        matchDiff = sum / OPP_DRAWS
      }
      // FL 価値クレジット（真値の最良推定 = 実測ジョーカー用テーブル）
      const creditDiff =
        (DEFAULT_FL_VALUES_JOKER[newP.flCards] ?? 0) - (DEFAULT_FL_VALUES_JOKER[oldP.flCards] ?? 0)
      const jDiff = matchDiff + creditDiff
      matchSum += matchDiff
      matchSum2 += matchDiff * matchDiff
      creditSum += creditDiff
      jSum += jDiff
      jSum2 += jDiff * jDiff

      if ((h + 1) % 200 === 0) {
        const mean = jSum / (h + 1)
        console.log(`  ...${h + 1}/${HANDS} hands, ΔJ=${mean.toFixed(3)}`)
      }
    }

    const n = HANDS
    const mMean = matchSum / n
    const mSe = Math.sqrt(Math.max(0, matchSum2 / n - mMean * mMean) / n)
    const cMean = creditSum / n
    const jMean = jSum / n
    const jSe = Math.sqrt(Math.max(0, jSum2 / n - jMean * jMean) / n)
    const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`
    console.log(`[A/B] hands=${n} 判断が分かれた=${pct(diffHands)}`)
    console.log(
      `[A/B] OLD: foul=${pct(stats.old.foul)} FL突入=${pct(stats.old.fl)} / NEW: foul=${pct(stats.new.foul)} FL突入=${pct(stats.new.fl)}`,
    )
    console.log(
      `[A/B] Δ対戦スコア=${mMean.toFixed(3)} ±${mSe.toFixed(3)}  ΔFLクレジット=${cMean.toFixed(3)}  ΔJ=${jMean.toFixed(3)} ±${jSe.toFixed(3)} (points/hand)`,
    )
    if (cMean > 0) {
      console.log(
        `[A/B] 損益分岐スケール s* = ${(-mMean / cMean).toFixed(2)} （真のFL価値がテーブルの s*倍超なら NEW が得）`,
      )
    }
  }, 7_200_000)
})

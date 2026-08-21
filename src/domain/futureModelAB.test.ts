// 未来モデル exact(旧) vs streets(新) の同一配牌ペア比較（52枚 ULTIMATE）。
// J = 対戦スコア + FL価値クレジット。flValueAB.test.ts と同じ手法。
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
import { type Board, DEFAULT_FL_VALUES, solveBest13, suggestInitial5, suggestStreet } from './solver'
import { ULTIMATE } from './variants'

const HANDS = Number(process.env.AB2_HANDS ?? 0)
const SEED_OFFSET = Number(process.env.AB2_SEED ?? 0) * 1_000_000
const OPP_DRAWS = 8

function playHand(deal: readonly Card[], model: 'exact' | 'streets', seed: number) {
  const rng = mulberry32(seed)
  let board: Board = suggestInitial5(deal.slice(0, 5), [], ULTIMATE, {
    iters: 64,
    refineTopK: 8,
    futureModel: model,
    rng,
  })[0].board
  const discards: Card[] = []
  for (let s = 0; s < 4; s++) {
    const drawn = deal.slice(5 + 3 * s, 8 + 3 * s)
    const best = suggestStreet(board, drawn, discards, ULTIMATE, {
      iters: 96,
      futureModel: model,
      rng,
    })[0]
    board = best.board
    if (best.discarded) discards.push(best.discarded)
  }
  const final = evaluateArrangement(board as Arrangement)
  return { final, flCards: fantasylandCards(final, ULTIMATE), board }
}

const boardKey = (bd: Board) =>
  (['top', 'middle', 'bottom'] as const)
    .map((r) => bd[r].map(cardId).sort((x, y) => x - y).join(','))
    .join('|')

describe('future model A/B (set AB2_HANDS to run)', () => {
  it.skipIf(HANDS <= 0)('52-card ultimate: exact (old) vs streets (new)', () => {
    const dealRng = mulberry32((0x5eed + SEED_OFFSET) >>> 0)
    const deck = makeDeck(false)
    let diff = 0
    let mSum = 0
    let mSum2 = 0
    let cSum = 0
    let jSum = 0
    let jSum2 = 0
    const st = { old: { foul: 0, fl: 0 }, new: { foul: 0, fl: 0 } }

    for (let h = 0; h < HANDS; h++) {
      shuffle(deck, dealRng)
      const deal = deck.slice(0, 17)
      const seed = 0x8b000 + SEED_OFFSET + h
      const oldP = playHand(deal, 'exact', seed)
      const newP = playHand(deal, 'streets', seed)
      if (oldP.final.fouled) st.old.foul++
      if (newP.final.fouled) st.new.foul++
      if (oldP.flCards > 0) st.old.fl++
      if (newP.flCards > 0) st.new.fl++

      let mDiff = 0
      if (boardKey(oldP.board) !== boardKey(newP.board)) {
        diff++
        const oppRng = mulberry32((0xee000 + SEED_OFFSET + h) >>> 0)
        const oppDeck = remainingDeck(deal, false)
        let sum = 0
        for (let k = 0; k < OPP_DRAWS; k++) {
          shuffle(oppDeck, oppRng)
          const opp: EvaluatedArrangement = solveBest13(oppDeck.slice(0, 13), ULTIMATE, {
            topK: 1,
          })[0].evaluated
          sum += scoreEvaluated(newP.final, opp, ULTIMATE) - scoreEvaluated(oldP.final, opp, ULTIMATE)
        }
        mDiff = sum / OPP_DRAWS
      }
      const cDiff = (DEFAULT_FL_VALUES[newP.flCards] ?? 0) - (DEFAULT_FL_VALUES[oldP.flCards] ?? 0)
      const jDiff = mDiff + cDiff
      mSum += mDiff
      mSum2 += mDiff * mDiff
      cSum += cDiff
      jSum += jDiff
      jSum2 += jDiff * jDiff
      if ((h + 1) % 100 === 0) console.log(`  ...${h + 1}/${HANDS} ΔJ=${(jSum / (h + 1)).toFixed(3)}`)
    }

    const n = HANDS
    const mMean = mSum / n
    const mSe = Math.sqrt(Math.max(0, mSum2 / n - mMean * mMean) / n)
    const jMean = jSum / n
    const jSe = Math.sqrt(Math.max(0, jSum2 / n - jMean * jMean) / n)
    const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`
    console.log(`[AB2] hands=${n} 判断が分かれた=${pct(diff)}`)
    console.log(
      `[AB2] OLD: foul=${pct(st.old.foul)} FL=${pct(st.old.fl)} / NEW: foul=${pct(st.new.foul)} FL=${pct(st.new.fl)}`,
    )
    console.log(
      `[AB2] Δ対戦=${mMean.toFixed(3)} ±${mSe.toFixed(3)} ΔFLクレジット=${(cSum / n).toFixed(3)} ΔJ=${jMean.toFixed(3)} ±${jSe.toFixed(3)}`,
    )
    if (cSum > 0) console.log(`[AB2] s* = ${(-mMean / (cSum / n)).toFixed(2)}`)
  }, 14_400_000)
})

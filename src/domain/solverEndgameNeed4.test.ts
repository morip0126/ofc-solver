// need=4（第2ストリート決定後）の2段厳密評価 evaluateBoardEndgameNeed4 のクロスチェック。
// 小さい山（6〜12枚）ならカード空間の完全列挙参照が現実的な時間で計算できる:
//   参照 V3 = 平均[全ての3枚コンボ D]( max[候補=2枚配置×捨て] evaluateBoardEndgame(子盤面) )
// evaluateBoardEndgame（need=2）は既にランク/カード両パスのクロスチェック済みなので参照に使える。
import { describe, expect, it } from 'vitest'
import { type Card, parseCards, remainingDeck } from './cards'
import { combinations, mulberry32, shuffle } from './combinatorics'
import {
  type Board,
  createNeed4Evaluator,
  evaluateBoardEndgame,
  evaluateBoardEndgameNeed4,
  generateStreetBoards,
  rankEndgameApplicable,
} from './solver'
import { ULTIMATE } from './variants'

const START: Board = { top: [], middle: parseCards('Kd Kh'), bottom: parseCards('6d 5h 3h') }

/** セル初期盤面に4枚をランダム配置した need=4 盤面（9枚）を作る。 */
function randomCellNeed4(rng: () => number): { board: Board; deckRest: Card[] } {
  const deck = remainingDeck([...START.middle, ...START.bottom], true)
  shuffle(deck, rng)
  const slots: ('top' | 'middle' | 'bottom')[] = [
    'top', 'top', 'top', 'middle', 'middle', 'middle', 'bottom', 'bottom',
  ]
  // 8つの空きから4つ埋める（空き4マス）
  const order = [0, 1, 2, 3, 4, 5, 6, 7]
  shuffle(order, rng)
  const board: Board = { top: [...START.top], middle: [...START.middle], bottom: [...START.bottom] }
  let d = 0
  for (const s of order.slice(0, 4)) board[slots[s]].push(deck[d++])
  return { board, deckRest: deck.slice(4) }
}

/** 参照実装: 3枚コンボ全列挙 × 候補ごとの need=2 厳密評価の最大 → 平均。 */
function referenceNeed4(board: Board, dead: Card[], deck: Card[]): number {
  let sum = 0
  let n = 0
  for (const drawn of combinations(deck, 3)) {
    let best = -Infinity
    for (const c of generateStreetBoards(board, drawn)) {
      const m = evaluateBoardEndgame(c.board, [...dead, c.discarded], ULTIMATE, { jokers: true })
      if (m.score > best) best = m.score
    }
    sum += best
    n++
  }
  return sum / n
}

describe('endgame need=4 two-step exact (M2)', () => {
  it('小さい山（7枚）でカード空間完全列挙の参照と厳密一致する', () => {
    const rng = mulberry32(0x4e44)
    for (let t = 0; t < 6; t++) {
      const { board, deckRest } = randomCellNeed4(rng)
      expect(rankEndgameApplicable(board)).toBe(true)
      // 山を7枚に絞る: 残り全部を dead にして 7 枚だけ未知として残す
      const unseen = deckRest.slice(0, 7)
      const dead = deckRest.slice(7)
      const exact = evaluateBoardEndgameNeed4(board, dead, ULTIMATE, { jokers: true })
      const ref = referenceNeed4(board, dead, unseen)
      expect(exact.score).toBeCloseTo(ref, 9)
      expect(exact.foulProb).toBeGreaterThanOrEqual(0)
      expect(exact.foulProb).toBeLessThanOrEqual(1)
      const bd = Object.values(exact.flBreakdown).reduce((a, b) => a + b, 0)
      expect(Math.abs(bd - exact.flProb)).toBeLessThan(1e-9)
    }
  })

  it('中規模の山（12枚・ジョーカー入り）でも参照と厳密一致する', () => {
    const rng = mulberry32(0x4e45)
    const { board, deckRest } = randomCellNeed4(rng)
    // ジョーカーを未知の山に必ず含める
    const jokers = deckRest.filter((c) => c.rank === 0)
    const naturals = deckRest.filter((c) => c.rank !== 0)
    const unseen = [...jokers, ...naturals.slice(0, 12 - jokers.length)]
    const dead = naturals.slice(12 - jokers.length)
    const exact = evaluateBoardEndgameNeed4(board, dead, ULTIMATE, { jokers: true })
    const ref = referenceNeed4(board, dead, unseen)
    expect(exact.score).toBeCloseTo(ref, 9)
  })

  it('盤面にジョーカーがあっても評価できる（f テーブルの不能ジョーカーペア回帰）', () => {
    // 9枚配置（need=4）: トップにジョーカー、ボトムは5枚完成
    const board: Board = {
      top: [{ rank: 0, suit: 'c' } as Card],
      middle: [...START.middle, ...parseCards('9c')],
      bottom: [...START.bottom, ...parseCards('4c 7s')],
    }
    const deck = remainingDeck(
      [...board.top, ...board.middle, ...board.bottom],
      true,
    )
    // 小さい山で参照とも一致させる（ジョーカー1枚は盤面、もう1枚を山に含める）
    const jokers = deck.filter((c) => c.rank === 0)
    const naturals = deck.filter((c) => c.rank !== 0)
    const unseen = [...jokers, ...naturals.slice(0, 8 - jokers.length)]
    const dead = naturals.slice(8 - jokers.length)
    const exact = evaluateBoardEndgameNeed4(board, dead, ULTIMATE, { jokers: true })
    const ref = referenceNeed4(board, dead, unseen)
    expect(exact.score).toBeCloseTo(ref, 9)
  })

  it('スケルトン付きエバリュエータのスコアが evaluateBoardEndgameNeed4 と厳密一致する', () => {
    const rng = mulberry32(0x5ce1)
    const ev = createNeed4Evaluator(ULTIMATE, { jokers: true })
    for (let t = 0; t < 15; t++) {
      const { board, deckRest } = randomCellNeed4(rng)
      // 同じ盤面形で捨て札を変えた2ケース（スケルトン再利用パスを通す）
      for (const deadN of [3, 5]) {
        const dead = deckRest.slice(0, deadN)
        const ref = evaluateBoardEndgameNeed4(board, dead, ULTIMATE, { jokers: true }).score
        const fast = ev.score(board, dead)
        expect(fast).toBeCloseTo(ref, 9)
      }
    }
  })

  it('スケルトン付きエバリュエータの metric が evaluateBoardEndgameNeed4 と厳密一致する', () => {
    const rng = mulberry32(0x5ce2)
    const ev = createNeed4Evaluator(ULTIMATE, { jokers: true })
    for (let t = 0; t < 8; t++) {
      const { board, deckRest } = randomCellNeed4(rng)
      const dead = deckRest.slice(0, 4)
      const ref = evaluateBoardEndgameNeed4(board, dead, ULTIMATE, { jokers: true })
      const m = ev.metric(board, dead)
      expect(m.score).toBeCloseTo(ref.score, 9)
      expect(m.expRoyalty).toBeCloseTo(ref.expRoyalty, 9)
      expect(m.flProb).toBeCloseTo(ref.flProb, 9)
      expect(m.flEV).toBeCloseTo(ref.flEV, 9)
      expect(m.foulProb).toBeCloseTo(ref.foulProb, 9)
      for (const k of [14, 15, 16, 17]) {
        expect(m.flBreakdown[k] ?? 0).toBeCloseTo(ref.flBreakdown[k] ?? 0, 9)
      }
    }
  })

  it('フルデッキ（40枚）の計算時間を計測する', () => {
    const rng = mulberry32(0x4e46)
    const { board } = randomCellNeed4(rng)
    const t0 = performance.now()
    const m = evaluateBoardEndgameNeed4(board, [], ULTIMATE, { jokers: true })
    const ms = performance.now() - t0
    console.log(`need=4 exact on full deck: ${ms.toFixed(0)}ms (score ${m.score.toFixed(3)})`)
    expect(m.score).toBeGreaterThan(-9)
  }, 120_000)
})

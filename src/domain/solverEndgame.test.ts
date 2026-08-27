// 終盤厳密評価（evaluateBoardEndgame / suggestStreet endgameExact）の性質テスト。
import { describe, expect, it } from 'vitest'
import { makeDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { type Arrangement, evaluateArrangement } from './score'
import { type Board, evaluateBoardEndgame, generateStreetBoards, suggestStreet } from './solver'
import { ULTIMATE } from './variants'

/** ランダムな「残り2マス」盤面（11枚配置）と次の3枚を作る。 */
function randomNearComplete(rng: () => number): { board: Board; drawn: ReturnType<typeof makeDeck> } {
  const deck = makeDeck(true)
  shuffle(deck, rng)
  // 空き2スロットをランダムに選ぶ（top3/mid5/bot5 の13スロットから2つ）
  const slots: ('top' | 'middle' | 'bottom')[] = [
    'top', 'top', 'top',
    'middle', 'middle', 'middle', 'middle', 'middle',
    'bottom', 'bottom', 'bottom', 'bottom', 'bottom',
  ]
  const i = Math.floor(rng() * 13)
  let j = Math.floor(rng() * 12)
  if (j >= i) j++
  const open = new Set([i, j])
  const board: Board = { top: [], middle: [], bottom: [] }
  let d = 0
  for (let k = 0; k < 13; k++) {
    if (open.has(k)) continue
    board[slots[k]].push(deck[d++])
  }
  return { board, drawn: deck.slice(11, 14) }
}

describe('endgame exact evaluation', () => {
  it('最終ストリート: 非ファウル手が存在する限り、厳密評価の1位はファウルしない', () => {
    const rng = mulberry32(0xe6d)
    for (let t = 0; t < 200; t++) {
      const { board, drawn } = randomNearComplete(rng)
      const sugg = suggestStreet(board, drawn, [], ULTIMATE, {
        endgameExact: true,
        jokers: true,
        iters: 1,
      })
      const anyClean = generateStreetBoards(board, drawn).some(
        (c) => !evaluateArrangement(c.board as Arrangement).fouled,
      )
      const topClean = !evaluateArrangement(sugg[0].board as Arrangement).fouled
      expect(topClean).toBe(anyClean)
    }
  })

  it('need=2 の期待値評価: 確率の整合（flProb = 内訳合計、foulProb ∈ [0,1]）', () => {
    const rng = mulberry32(0xe6e)
    for (let t = 0; t < 10; t++) {
      const { board } = randomNearComplete(rng)
      const m = evaluateBoardEndgame(board, [], ULTIMATE, { jokers: true })
      expect(m.foulProb).toBeGreaterThanOrEqual(0)
      expect(m.foulProb).toBeLessThanOrEqual(1)
      const bd = Object.values(m.flBreakdown).reduce((a, b) => a + b, 0)
      expect(Math.abs(bd - m.flProb)).toBeLessThan(1e-9)
      expect(m.score).toBeCloseTo(m.expRoyalty + m.flEV - 9 * m.foulProb, 6)
    }
  })
})

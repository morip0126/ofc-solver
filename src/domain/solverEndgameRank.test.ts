// 終盤厳密（need=2）のランク空間高速パス vs カード空間全列挙（参照実装）のクロスチェック。
// KKセル（M[KdKh] B[6d5h3h]）由来の盤面はスートが結果に影響しない（フラッシュ構造的不可能）
// ため、両者は厳密に一致しなければならない。
import { describe, expect, it } from 'vitest'
import { type Card, parseCards, remainingDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { type Board, evaluateBoardEndgame, rankEndgameApplicable } from './solver'
import { ULTIMATE } from './variants'

const START: Board = { top: [], middle: parseCards('Kd Kh'), bottom: parseCards('6d 5h 3h') }

/** セルの初期盤面から6枚をランダム配置した「残り2マス」盤面と捨て札3枚を作る。 */
function randomCellNeed2(rng: () => number): { board: Board; dead: Card[] } {
  const deck = remainingDeck([...START.middle, ...START.bottom], true)
  shuffle(deck, rng)
  const slots: ('top' | 'middle' | 'bottom')[] = [
    'top', 'top', 'top', 'middle', 'middle', 'middle', 'bottom', 'bottom',
  ]
  const i = Math.floor(rng() * 8)
  let j = Math.floor(rng() * 7)
  if (j >= i) j++
  const board: Board = { top: [...START.top], middle: [...START.middle], bottom: [...START.bottom] }
  let d = 0
  for (let s = 0; s < 8; s++) {
    if (s === i || s === j) continue
    board[slots[s]].push(deck[d++])
  }
  return { board, dead: deck.slice(6, 9) }
}

describe('endgame need=2: rank-space fast path vs card-space reference', () => {
  it('KKセル由来の盤面では両パスが厳密に一致する（ジョーカー込み・40盤面）', () => {
    const rng = mulberry32(0x4a4a)
    let tRank = 0
    let tCard = 0
    let jokerBoards = 0
    for (let t = 0; t < 40; t++) {
      const { board, dead } = randomCellNeed2(rng)
      expect(rankEndgameApplicable(board)).toBe(true)
      if ([...board.top, ...board.middle, ...board.bottom].some((c) => c.rank === 0)) jokerBoards++
      let t0 = performance.now()
      const fast = evaluateBoardEndgame(board, dead, ULTIMATE, { jokers: true })
      tRank += performance.now() - t0
      t0 = performance.now()
      const ref = evaluateBoardEndgame(board, dead, ULTIMATE, {
        jokers: true,
        endgameCardSpace: true,
      })
      tCard += performance.now() - t0
      expect(fast.score).toBeCloseTo(ref.score, 9)
      expect(fast.expRoyalty).toBeCloseTo(ref.expRoyalty, 9)
      expect(fast.flProb).toBeCloseTo(ref.flProb, 9)
      expect(fast.flEV).toBeCloseTo(ref.flEV, 9)
      expect(fast.foulProb).toBeCloseTo(ref.foulProb, 9)
      expect(fast.scoreVar).toBeCloseTo(ref.scoreVar, 6)
      const keys = new Set([...Object.keys(fast.flBreakdown), ...Object.keys(ref.flBreakdown)])
      for (const k of keys) {
        expect(fast.flBreakdown[Number(k)] ?? 0).toBeCloseTo(ref.flBreakdown[Number(k)] ?? 0, 9)
      }
    }
    // ジョーカー盤面もクロスチェックに含まれていること（40盤面中の期待値 ≈ 10）
    expect(jokerBoards).toBeGreaterThan(2)
    console.log(
      `rank-space ${tRank.toFixed(0)}ms vs card-space ${tCard.toFixed(0)}ms ` +
        `(${(tCard / tRank).toFixed(1)}x, joker boards: ${jokerBoards}/40)`,
    )
  })

  it('ジョーカーを盤面に固定したケースでも一致する', () => {
    const board: Board = {
      top: parseCards('Qs'),
      middle: [...parseCards('Kd Kh 9c 9d'), { rank: 0, suit: 'c' } as Card],
      bottom: parseCards('6d 5h 3h 4c 7s'),
    }
    // ミドルにジョーカー: maxSuit(1) + joker(1) + 空き(0) = 2 ≤ 4 → 適用可
    expect(rankEndgameApplicable(board)).toBe(true)
    const fast = evaluateBoardEndgame(board, [], ULTIMATE, { jokers: true })
    const ref = evaluateBoardEndgame(board, [], ULTIMATE, { jokers: true, endgameCardSpace: true })
    expect(fast.score).toBeCloseTo(ref.score, 9)
    expect(fast.flProb).toBeCloseTo(ref.flProb, 9)
    expect(fast.foulProb).toBeCloseTo(ref.foulProb, 9)
  })

  it('フラッシュが可能な盤面ではランクパスを適用しない（ガード）', () => {
    // ボトムがクラブ4枚 + 空き1 → フラッシュ到達可能
    const flushy: Board = {
      top: parseCards('2d 3s 4d'),
      middle: parseCards('Kd Kh 9c 9d 8s'),
      bottom: parseCards('2c 7c Tc Jc'),
    }
    expect(rankEndgameApplicable(flushy)).toBe(false)
    // ジョーカーはワイルドとしてスート潜在にカウントする: クラブ3 + ジョーカー1 + 空き1 = 5
    const jokerFlushy: Board = {
      top: parseCards('2d 3s 4d'),
      middle: parseCards('Kd Kh 9c 9d 8s'),
      bottom: [...parseCards('2c 7c Tc'), { rank: 0, suit: 'c' } as Card],
    }
    expect(rankEndgameApplicable(jokerFlushy)).toBe(false)
  })
})

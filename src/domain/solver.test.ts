import { describe, it, expect } from 'vitest'
import { type Card, cardId, parseCards } from './cards'
import { mulberry32 } from './combinatorics'
import { HandCategory, categoryOf } from './evaluator'
import type { Arrangement } from './score'
import { NORMAL, ULTIMATE } from './variants'
import {
  type Board,
  DEFAULT_FL_VALUES,
  DEFAULT_FL_VALUES_JOKER,
  COMBINED_FL_SCALE,
  HINDSIGHT_FL_SCALE,
  bestCompletion,
  estimateEVvsRandom,
  evaluateBoard,
  generateStreetBoards,
  solveBest13,
  suggestStreet,
} from './solver'

const has = (cards: Card[], code: string) => cards.some((c) => cardId(c) === cardId(parseCards(code)[0]))

describe('solveBest13', () => {
  const hand = parseCards('As Ks Qs Js Ts 2c 2d 2h 5c 7d 9h 4s 6s')

  it('never returns a fouled arrangement', () => {
    const results = solveBest13(hand, NORMAL, { topK: 20 })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) expect(r.evaluated.fouled).toBe(false)
  })

  it('keeps the royal flush on the bottom for max royalties', () => {
    const best = solveBest13(hand, NORMAL, { topK: 1 })[0]
    expect(categoryOf(best.evaluated.bottom)).toBe(HandCategory.StraightFlush)
    // 底 royal(25) + 中トリップス222(2) が最善で 27
    expect(best.royalties).toBe(27)
  })

  it('respects topK', () => {
    expect(solveBest13(hand, NORMAL, { topK: 3 })).toHaveLength(3)
  })
})

describe('bestCompletion', () => {
  it('keeps fixed cards in their rows and avoids fouling', () => {
    const board: Board = {
      top: [],
      middle: [],
      bottom: parseCards('As Ks Qs Js Ts'), // 固定の royal
    }
    const free = parseCards('Kh Kd Kc Qh Qd 2c 3d 4h') // 8枚で残り 3(top)+5(middle) を埋める
    const best = bestCompletion(board, free, NORMAL)
    expect(best).not.toBeNull()
    expect(best!.evaluated.fouled).toBe(false)
    // bottom は固定の royal のまま動かない
    for (const code of ['As', 'Ks', 'Qs', 'Js', 'Ts']) {
      expect(has(best!.arrangement.bottom, code)).toBe(true)
    }
    expect(categoryOf(best!.evaluated.bottom)).toBe(HandCategory.StraightFlush)
  })
})

describe('generateStreetBoards', () => {
  it('adds exactly 2 cards and discards 1 from the drawn set', () => {
    const current: Board = {
      top: parseCards('2h 3c'),
      middle: parseCards('5h 6h 7h'),
      bottom: parseCards('9s Ts Js'),
    }
    const drawn = parseCards('Kd Qc 4s')
    const boards = generateStreetBoards(current, drawn)
    const currentCount = 2 + 3 + 3
    for (const { board, discarded } of boards) {
      const count = board.top.length + board.middle.length + board.bottom.length
      expect(count).toBe(currentCount + 2)
      const all = [...board.top, ...board.middle, ...board.bottom]
      expect(all.some((c) => cardId(c) === cardId(discarded))).toBe(false)
    }
    expect(boards.length).toBeGreaterThan(0)
  })
})

describe('suggestStreet (completing to 13)', () => {
  it('recommends the placement that builds two straight flushes', () => {
    const current: Board = {
      top: parseCards('2h 3c 4d'), // top 完成（3枚）
      middle: parseCards('5h 6h 7h 8h'), // あと1枚
      bottom: parseCards('9s Ts Js Qs'), // あと1枚
    }
    const drawn = parseCards('9h Ks 2c')
    const best = suggestStreet(current, drawn, [], NORMAL)[0]
    // 9h→middle で 9ハイSF(30)、Ks→bottom で KハイSF(15)、2c を捨てる
    expect(best.foulProb).toBe(0)
    expect(best.discarded.rank).toBe(2) // 2c を捨てる
    expect(has(best.board.middle, '9h')).toBe(true)
    expect(has(best.board.bottom, 'Ks')).toBe(true)
    expect(best.expRoyalty).toBe(45) // middle SF(30) + bottom K-high SF(15)
  })
})

describe('estimateEVvsRandom', () => {
  it('a monster hand has positive EV; a fouled hand has negative EV', () => {
    const rng = mulberry32(12345)
    const monster: Arrangement = {
      top: parseCards('Ah Ac Ad'),
      middle: parseCards('Ks Kh Kd Qs Qh'),
      bottom: parseCards('5s 6s 7s 8s 9s'),
    }
    // 既定の相手ポリシーは1手ごとに全探索するため重い。少数イテレーションで十分判定できる。
    const ev = estimateEVvsRandom(monster, [], NORMAL, { iters: 8, rng })
    expect(ev).toBeGreaterThan(0)

    const fouled: Arrangement = {
      top: parseCards('Ah Ac Ad'),
      middle: parseCards('2s 3s 4s 5s 7s'),
      bottom: parseCards('2h 3c 4d 5c 8h'),
    }
    // ファウルは相手が何であれ必ず失点するので、少数でも符号は安定する。
    const evFoul = estimateEVvsRandom(fouled, [], NORMAL, { iters: 4, rng: mulberry32(1) })
    expect(evFoul).toBeLessThan(0)
  })
})

describe('evaluateBoard FL value table selection', () => {
  // 完成盤面（top QQ で FL 突入、ULTIMATE なら14枚）の flEV が、
  // デッキに応じた実測テーブルの値になること。
  const board: Board = {
    top: parseCards('Qs Qh 2c'),
    middle: parseCards('Ac Ad 5h 6s 8c'),
    bottom: parseCards('Kc Kd 9h 9s 7d'),
  }

  it('uses the 52-card table by default (combined はスケール適用)', () => {
    const m = evaluateBoard(board, [], ULTIMATE)
    expect(m.foulProb).toBe(0)
    expect(m.flEV).toBeCloseTo(DEFAULT_FL_VALUES[14] * COMBINED_FL_SCALE, 6)
  })

  it('uses the joker table when jokers=true', () => {
    const m = evaluateBoard(board, [], ULTIMATE, { jokers: true })
    expect(m.flEV).toBeCloseTo(DEFAULT_FL_VALUES_JOKER[14] * COMBINED_FL_SCALE, 6)
  })

  it('hindsight モデルは FL 価値をスケールして使う', () => {
    const m = evaluateBoard(board, [], ULTIMATE, { futureModel: 'hindsight' })
    expect(m.flEV).toBeCloseTo(DEFAULT_FL_VALUES[14] * HINDSIGHT_FL_SCALE, 6)
  })
})

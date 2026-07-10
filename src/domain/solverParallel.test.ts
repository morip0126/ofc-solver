// 並列分割 API の等価性テスト。
// チャンク分割（evaluateInitialChunk / evaluateStreetChunk）と FL の bottomRange 分割が、
// どのように分割しても単一実行と同じ結果になることを担保する。

import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { choose, mulberry32 } from './combinatorics'
import {
  estimateEVvsRandom,
  estimateEVvsRandomStats,
  evaluateInitialChunk,
  evaluateStreetChunk,
  generateInitialBoards,
  generateStreetBoards,
  solveFantasyland,
} from './solver'
import { VARIANTS } from './variants'

const variant = VARIANTS.normal

describe('evaluateInitialChunk', () => {
  it('チャンク分割しても全体一括評価と一致する（seed 固定）', () => {
    const cards = parseCards('As Kd 7h 7c 2s')
    const dead = parseCards('Qd Qc')
    const total = generateInitialBoards(cards).length
    const all = Array.from({ length: total }, (_, i) => i)

    const whole = evaluateInitialChunk(cards, dead, variant, all, { iters: 10, seed: 42 })
    const parts = [
      ...evaluateInitialChunk(cards, dead, variant, all.slice(0, 77), { iters: 10, seed: 42 }),
      ...evaluateInitialChunk(cards, dead, variant, all.slice(77, 160), { iters: 10, seed: 42 }),
      ...evaluateInitialChunk(cards, dead, variant, all.slice(160), { iters: 10, seed: 42 }),
    ]
    expect(parts).toEqual(whole)
  })

  it('ジョーカー入りでも分割不変', () => {
    const cards = parseCards('X1 Kd 7h 7c 2s')
    const total = generateInitialBoards(cards).length
    const all = Array.from({ length: total }, (_, i) => i)
    const whole = evaluateInitialChunk(cards, [], variant, all, { iters: 6, seed: 7, jokers: true })
    const parts = [
      ...evaluateInitialChunk(cards, [], variant, all.slice(0, 100), { iters: 6, seed: 7, jokers: true }),
      ...evaluateInitialChunk(cards, [], variant, all.slice(100), { iters: 6, seed: 7, jokers: true }),
    ]
    expect(parts).toEqual(whole)
  })
})

describe('evaluateStreetChunk', () => {
  it('チャンク分割しても全体一括評価と一致する（seed 固定）', () => {
    const board = {
      top: parseCards('Qh'),
      middle: parseCards('8s 8d'),
      bottom: parseCards('Ad Kc'),
    }
    const drawn = parseCards('Qs 4h 4c')
    const dead = parseCards('2c 2d')
    const total = generateStreetBoards(board, drawn).length
    const all = Array.from({ length: total }, (_, i) => i)

    const whole = evaluateStreetChunk(board, drawn, dead, variant, all, { iters: 12, seed: 99 })
    const mid = Math.floor(total / 2)
    const parts = [
      ...evaluateStreetChunk(board, drawn, dead, variant, all.slice(0, mid), { iters: 12, seed: 99 }),
      ...evaluateStreetChunk(board, drawn, dead, variant, all.slice(mid), { iters: 12, seed: 99 }),
    ]
    expect(parts).toEqual(whole)
  })
})

describe('solveFantasyland の bottomRange 分割', () => {
  it('範囲ごとの結果を目的値降順にマージすると全域探索と一致する', () => {
    const cards = parseCards('As Ah Ad Ks Kh Qs Qh Jd Ts 9c 8c 7d 6h 5s')
    const full = solveFantasyland(cards, variant, { topK: 3 })
    const n5 = choose(cards.length, 5)
    const third = Math.floor(n5 / 3)
    const merged = [
      ...solveFantasyland(cards, variant, { topK: 3, bottomRange: [0, third] }),
      ...solveFantasyland(cards, variant, { topK: 3, bottomRange: [third, 2 * third] }),
      ...solveFantasyland(cards, variant, { topK: 3, bottomRange: [2 * third, n5] }),
    ]
      .sort((a, b) => b.objective - a.objective)
      .slice(0, 3)

    expect(merged.map((r) => r.objective)).toEqual(full.map((r) => r.objective))
    expect(merged.map((r) => r.royalties)).toEqual(full.map((r) => r.royalties))
    expect(merged.map((r) => r.stays)).toEqual(full.map((r) => r.stays))
  })
})

describe('estimateEVvsRandomStats', () => {
  const arrangement = {
    top: parseCards('Qs Qh 2c'),
    middle: parseCards('Ks Kd 9h 8c 3d'),
    bottom: parseCards('As Ac Ad 7s 4h'),
  }

  it('mean が estimateEVvsRandom（同一シード）と一致する', () => {
    const stats = estimateEVvsRandomStats(arrangement, [], variant, {
      iters: 40,
      rng: mulberry32(7),
    })
    const mean = estimateEVvsRandom(arrangement, [], variant, { iters: 40, rng: mulberry32(7) })
    expect(stats.mean).toBe(mean)
    expect(stats.n).toBe(40)
    expect(stats.m2).toBeGreaterThanOrEqual(0)
  })

  it('分散（m2）から妥当な標準誤差が得られる', () => {
    const stats = estimateEVvsRandomStats(arrangement, [], variant, {
      iters: 60,
      rng: mulberry32(11),
    })
    const se = Math.sqrt(stats.m2 / (stats.n - 1) / stats.n)
    // 対戦スコアの散らばりは1点以上あるはずで、60反復の SE は極端な値にならない。
    expect(se).toBeGreaterThan(0)
    expect(se).toBeLessThan(10)
  })
})

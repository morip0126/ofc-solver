import { describe, it } from 'vitest'
import { cardToString, parseCards } from './cards'
import { evaluateInitialChunk, generateInitialBoards } from './solver'
import { ULTIMATE } from './variants'

describe('combined score list', () => {
  it.skipIf(process.env.COMBINED_LIST !== '1')('all 232 sorted', () => {
    const cards = parseCards('Kd Kh 6d 5h 3h')
    const boards = generateInitialBoards(cards)
    const all = Array.from({ length: boards.length }, (_, i) => i)
    const res = evaluateInitialChunk(cards, [], ULTIMATE, all, {
      iters: 64, seed: 0xc0de, jokers: true, futureModel: 'combined',
    })
    res.sort((a, b) => b.score - a.score)
    const row = (cs: readonly { rank: number }[]) => cs.map((c) => cardToString(c as never)).join(',') || '-'
    res.slice(0, 30).forEach((m, i) => {
      const b = boards[m.index]
      console.log(`${String(i + 1).padStart(2)}位 #${m.index} T[${row(b.top)}] M[${row(b.middle)}] B[${row(b.bottom)}] score=${m.score.toFixed(1)} foul=${(100 * m.foulProb).toFixed(0)}% fl=${(100 * m.flProb).toFixed(0)}%`)
    })
  }, 1_200_000)
})

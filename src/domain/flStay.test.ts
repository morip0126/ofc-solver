import { describe, expect, it } from 'vitest'
import { makeDeck, parseCards } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { canStayFantasyland, stayFeasibility } from './flStay'
import { solveFantasyland } from './solver'
import { NORMAL } from './variants'

// 参照実装: stayBonus を巨大にすれば、solveFantasyland はリステイ可能なとき必ず
// リステイ配置を最上位に返す（リステイの目的値がロイヤリティ差を常に上回るため）。
function canStayReference(cards: Parameters<typeof solveFantasyland>[0]): boolean {
  const best = solveFantasyland(cards, NORMAL, { stayBonus: 1_000_000, topK: 1 })[0]
  return best ? best.stays : false
}

describe('stayFeasibility (handcrafted)', () => {
  it('stays via top trips with two straights below', () => {
    const cards = parseCards('As Ah Ad 2c 3d 4h 5s 6c 7c 8d 9h Ts Jc 2d')
    const f = stayFeasibility(cards)
    expect(f.viaTop).toBe(true)
    expect(canStayFantasyland(cards)).toBe(canStayReference(cards))
  })

  it('stays via bottom quads with junk elsewhere', () => {
    const cards = parseCards('9c 9d 9h 9s 2c 3d 5h 7s 8c Jd Qh Kc As 4d')
    const f = stayFeasibility(cards)
    expect(f.viaBottom).toBe(true)
    expect(canStayFantasyland(cards)).toBe(true)
    expect(canStayReference(cards)).toBe(true)
  })

  it('cannot stay when low trips has no two five-card hands above it', () => {
    // top 222 に対して middle ≥ トリップスが要るが、残りはツーペア止まり。
    const cards = parseCards('2c 2d 2h 3c 3d 4h 4s 8c 8d 9h 9s Kc Kd Qh')
    expect(canStayFantasyland(cards)).toBe(false)
    expect(canStayReference(cards)).toBe(false)
  })

  it('cannot stay with AAA+KKK when no bottom can cover the full house', () => {
    // トリップスが2組あっても、middle/bottom の両方をトリップス以上にできない微妙なケース。
    const cards = parseCards('As Ah Ad Kc Kd Kh Qc Qd Jc Jd Tc Td 9c 8d')
    expect(canStayFantasyland(cards)).toBe(canStayReference(cards))
  })

  it('cannot stay with a pair-only 13-card hand', () => {
    const cards = parseCards('2c 2d 5h 6s 8c 8d 9h Ts Jc Qd Kh Ac 3s')
    expect(canStayFantasyland(cards)).toBe(false)
  })
})

describe('stayFeasibility vs solveFantasyland (cross-check)', () => {
  const CASES: [n: number, hands: number][] = [
    [13, 50],
    [14, 50],
    [15, 10],
    [16, 4],
    [17, 2],
  ]

  for (const [n, hands] of CASES) {
    it(
      `matches the exhaustive solver for ${n}-card hands`,
      () => {
        const rng = mulberry32(0xf15a + n)
        const deck = makeDeck()
        for (let i = 0; i < hands; i++) {
          shuffle(deck, rng)
          const cards = deck.slice(0, n)
          expect(canStayFantasyland(cards), cards.map((c) => `${c.rank}${c.suit}`).join(' ')).toBe(
            canStayReference(cards),
          )
        }
      },
      120_000,
    )
  }
})

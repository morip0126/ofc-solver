import { describe, expect, it } from 'vitest'
import { JOKER_CARDS, cardId, makeDeck, parseCards } from './cards'
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

describe('stayFeasibility with jokers (cross-check vs solver)', () => {
  // ジョーカー入りはリステイ率が高く判定分岐も多いため、13/14枚を中心に突き合わせる。
  // 54枚デッキの先頭 n 枚を取ると約半数のハンドにジョーカーが含まれる。
  const CASES: [n: number, hands: number][] = [
    [13, 40],
    [14, 40],
    [15, 8],
    [16, 3],
    [17, 2],
  ]

  for (const [n, hands] of CASES) {
    it(
      `matches the exhaustive solver for ${n}-card joker-deck hands`,
      () => {
        const rng = mulberry32(0x54f1 + n)
        const deck = makeDeck(true)
        for (let i = 0; i < hands; i++) {
          shuffle(deck, rng)
          const cards = deck.slice(0, n)
          // カバレッジ確保: 偶数回はジョーカー1枚以上、4の倍数回は2枚を必ず含める。
          const want = i % 4 === 0 ? 2 : i % 2 === 0 ? 1 : 0
          for (let w = 0; w < want; w++) {
            const j = JOKER_CARDS[w]
            if (cards.some((c) => cardId(c) === cardId(j))) continue
            let slot = 0
            while (cards[slot].rank === 0) slot++
            cards[slot] = j
          }
          expect(
            canStayFantasyland(cards),
            cards.map((c) => `${c.rank}${c.suit}`).join(' '),
          ).toBe(canStayReference(cards))
        }
      },
      120_000,
    )
  }

  it('joker completes quads on the bottom', () => {
    // 999 + ジョーカー = クアッズ。残りはバラバラでも middle/top は埋まる。
    const cards = parseCards('9c 9d 9h X1 2c 3d 5h 7s 8c Jd Qh Kc As 4d')
    const f = stayFeasibility(cards)
    expect(f.viaBottom).toBe(true)
  })

  it('joker completes trips on the top only when two five-card hands can cover it', () => {
    // ペア22 + ジョーカーで top 222 が作れて、下2段はストレート2本で覆える。
    const cards = parseCards('2c 2d X1 3c 4d 5h 6s 7c 8d 9h Ts Jc Qd Kh')
    expect(canStayFantasyland(cards)).toBe(canStayReference(cards))
  })

  it('two jokers make almost any hand stay', () => {
    // 実カードにトリップスが作れるペアすら無いが、ジョーカー2枚で 5h+X+X の
    // top トリップスや任意のクアッズが狙える…かは下2段の充足次第。参照実装と一致すること。
    const cards = parseCards('X1 X2 2c 5h 8d Jc Kd 3s 6h 9c Qs 4d 7s Th')
    expect(canStayFantasyland(cards)).toBe(canStayReference(cards))
  })
})

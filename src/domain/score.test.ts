import { describe, it, expect } from 'vitest'
import { parseCards } from './cards'
import {
  type Arrangement,
  evaluateArrangement,
  fantasylandCards,
  royaltiesTotal,
  scorePairwise,
} from './score'
import { NORMAL, ULTIMATE } from './variants'

function arr(top: string, middle: string, bottom: string): Arrangement {
  return { top: parseCards(top), middle: parseCards(middle), bottom: parseCards(bottom) }
}

describe('foul detection', () => {
  it('valid arrangement (bottom >= middle >= top) is not fouled', () => {
    const a = arr('2h 3c 5d', '7h 7c 4d 9s Jh', 'As Ks Qs Js Ts')
    expect(evaluateArrangement(a).fouled).toBe(false)
  })

  it('flags bottom weaker than middle', () => {
    const a = arr('2h 3c 5d', 'As Ks Qs Js Ts', '7h 7c 4d 9s Jh')
    expect(evaluateArrangement(a).fouled).toBe(true)
  })

  it('flags top stronger than middle (trips top vs two pair middle)', () => {
    const a = arr('9h 9c 9d', '4h 4c 5d 5s 8h', 'As Ac Kd Ks 2h')
    expect(evaluateArrangement(a).fouled).toBe(true)
  })

  it('equal rows are allowed (not a foul)', () => {
    // middle と bottom が完全に同格のツーペア（88 33 T キッカー）でも bottom>=middle は成立。
    const a = arr('2h 4c 5d', '8h 8c 3d 3s Td', '8d 8s 3h 3c Th')
    expect(evaluateArrangement(a).fouled).toBe(false)
  })
})

describe('royalties total', () => {
  it('sums all three rows when valid', () => {
    // top QQ(=7) + middle straight(=4) + bottom flush(=4)
    const a = arr('Qh Qc 2d', '5h 6c 7d 8s 9h', '2s 5s 9s Js Ks')
    expect(royaltiesTotal(evaluateArrangement(a))).toBe(15)
  })

  it('is zero when fouled', () => {
    const a = arr('2h 3c 5d', 'As Ks Qs Js Ts', '7h 7c 4d 9s Jh')
    expect(royaltiesTotal(evaluateArrangement(a))).toBe(0)
  })
})

describe('fantasyland entry', () => {
  it('normal: QQ+ top grants 14, JJ grants none', () => {
    const qq = arr('Qh Qc 2d', 'Ah Ac 3d 4s 5h', '6s 6h 6d 7c 7s')
    const jj = arr('Jh Jc 2d', 'Ah Ac 3d 4s 5h', '6s 6h 6d 7c 7s')
    expect(fantasylandCards(evaluateArrangement(qq), NORMAL)).toBe(14)
    expect(fantasylandCards(evaluateArrangement(jj), NORMAL)).toBe(0)
  })

  it('ultimate: progressive QQ=14, KK=15, trips=17', () => {
    const qq = arr('Qh Qc 2d', 'Ah Ac 3d 4s 5h', '6s 6h 6d 7c 7s')
    const kk = arr('Kh Kc 2d', 'Ah Ac 3d 4s 5h', '6s 6h 6d 7c 7s')
    const aaa = arr('Ah Ac Ad', 'Ks Kh Kd Qs Qh', '5s 6s 7s 8s 9s')
    expect(fantasylandCards(evaluateArrangement(qq), ULTIMATE)).toBe(14)
    expect(fantasylandCards(evaluateArrangement(kk), ULTIMATE)).toBe(15)
    expect(fantasylandCards(evaluateArrangement(aaa), ULTIMATE)).toBe(17)
  })

  it('no fantasyland when fouled', () => {
    const fouled = arr('Ah Ac Ad', 'As Ks Qs Js Ts', '2h 3c 4d 5s 7h')
    expect(fantasylandCards(evaluateArrangement(fouled), NORMAL)).toBe(0)
  })
})

describe('pairwise scoring', () => {
  // top KK=8, mid straight=4, bottom royal=25 → royalties 37
  const strong = arr('Kh Kc 2d', '5h 6c 7d 8s 9h', 'As Ks Qs Js Ts')
  // 役なし・全段で strong に負ける非ファウル配置
  const weak = arr('2h 3c 5d', '4h 4c 6d 7s 9h', '8h 8s 9d 9c Jh')

  it('is a legal (non-fouled) matchup', () => {
    expect(evaluateArrangement(strong).fouled).toBe(false)
    expect(evaluateArrangement(weak).fouled).toBe(false)
  })

  it('scoops and adds royalty differential', () => {
    // strong: 3段勝ち(+3) + スクープ(+3) + ロイヤリティ37 = 43
    expect(scorePairwise(strong, weak, NORMAL)).toBe(43)
    expect(scorePairwise(weak, strong, NORMAL)).toBe(-43)
  })

  it('fouling loses 6 plus opponent royalties', () => {
    const fouler = arr('Ah Ac Ad', 'As Ks Qs Js Ts', '2h 3c 4d 5s 7h') // fouled
    expect(scorePairwise(fouler, strong, NORMAL)).toBe(-43)
    expect(scorePairwise(strong, fouler, NORMAL)).toBe(43)
  })

  it('both fouled is a wash', () => {
    const f1 = arr('Ah Ac Ad', 'As Ks Qs Js Ts', '2h 3c 4d 5s 7h')
    const f2 = arr('Kh Kc Kd', 'Ks Qs Js Ts 9s', '2c 3d 4h 5c 7d')
    expect(scorePairwise(f1, f2, NORMAL)).toBe(0)
  })
})

import { describe, it, expect } from 'vitest'
import { parseCards } from './cards'
import { evaluate3, evaluate5 } from './evaluator'
import { royaltyBottom, royaltyMiddle, royaltyTop } from './royalties'

describe('top royalties', () => {
  it('scores pairs 66..AA as 1..9', () => {
    expect(royaltyTop(evaluate3(parseCards('5h 5c 2d')))).toBe(0) // 55 は無得点
    expect(royaltyTop(evaluate3(parseCards('6h 6c 2d')))).toBe(1)
    expect(royaltyTop(evaluate3(parseCards('Qh Qc 2d')))).toBe(7)
    expect(royaltyTop(evaluate3(parseCards('Ah Ac 2d')))).toBe(9)
  })

  it('scores trips 222..AAA as 10..22', () => {
    expect(royaltyTop(evaluate3(parseCards('2h 2c 2d')))).toBe(10)
    expect(royaltyTop(evaluate3(parseCards('Ah Ac Ad')))).toBe(22)
  })

  it('high card top scores 0', () => {
    expect(royaltyTop(evaluate3(parseCards('Ah Kc Qd')))).toBe(0)
  })
})

describe('middle royalties', () => {
  it('follows the middle table incl. royal flush', () => {
    expect(royaltyMiddle(evaluate5(parseCards('7h 7c 7d 2s 3h')))).toBe(2) // trips
    expect(royaltyMiddle(evaluate5(parseCards('5h 6c 7d 8s 9h')))).toBe(4) // straight
    expect(royaltyMiddle(evaluate5(parseCards('2h 5h 8h Jh Kh')))).toBe(8) // flush
    expect(royaltyMiddle(evaluate5(parseCards('9h 9c 9d 2s 2c')))).toBe(12) // full house
    expect(royaltyMiddle(evaluate5(parseCards('9h 9c 9d 9s 2c')))).toBe(20) // quads
    expect(royaltyMiddle(evaluate5(parseCards('5s 6s 7s 8s 9s')))).toBe(30) // straight flush
    expect(royaltyMiddle(evaluate5(parseCards('As Ks Qs Js Ts')))).toBe(50) // royal
    expect(royaltyMiddle(evaluate5(parseCards('Ah Ac 3d 5s 8h')))).toBe(0) // pair: no middle royalty
  })
})

describe('bottom royalties', () => {
  it('follows the bottom table incl. royal flush', () => {
    expect(royaltyBottom(evaluate5(parseCards('5h 6c 7d 8s 9h')))).toBe(2) // straight
    expect(royaltyBottom(evaluate5(parseCards('2h 5h 8h Jh Kh')))).toBe(4) // flush
    expect(royaltyBottom(evaluate5(parseCards('9h 9c 9d 2s 2c')))).toBe(6) // full house
    expect(royaltyBottom(evaluate5(parseCards('9h 9c 9d 9s 2c')))).toBe(10) // quads
    expect(royaltyBottom(evaluate5(parseCards('5s 6s 7s 8s 9s')))).toBe(15) // straight flush
    expect(royaltyBottom(evaluate5(parseCards('As Ks Qs Js Ts')))).toBe(25) // royal
    expect(royaltyBottom(evaluate5(parseCards('7h 7c 7d 2s 3h')))).toBe(0) // trips: no bottom royalty
  })
})

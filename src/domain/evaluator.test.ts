import { describe, it, expect } from 'vitest'
import { parseCards } from './cards'
import {
  HandCategory,
  categoryOf,
  compareHand,
  evaluate3,
  evaluate5,
  isRoyalFlush,
} from './evaluator'

function cat5(codes: string): HandCategory {
  return categoryOf(evaluate5(parseCards(codes)))
}

describe('evaluate5 categories', () => {
  it('classifies each 5-card category', () => {
    expect(cat5('As Ks Qs Js Ts')).toBe(HandCategory.StraightFlush)
    expect(cat5('9h 9c 9d 9s 2c')).toBe(HandCategory.Quads)
    expect(cat5('9h 9c 9d 2s 2c')).toBe(HandCategory.FullHouse)
    expect(cat5('2h 5h 8h Jh Kh')).toBe(HandCategory.Flush)
    expect(cat5('5h 6c 7d 8s 9h')).toBe(HandCategory.Straight)
    expect(cat5('7h 7c 7d 2s 9h')).toBe(HandCategory.Trips)
    expect(cat5('7h 7c 4d 4s 9h')).toBe(HandCategory.TwoPair)
    expect(cat5('7h 7c 4d 9s Jh')).toBe(HandCategory.Pair)
    expect(cat5('2h 5c 8d Js Kh')).toBe(HandCategory.HighCard)
  })

  it('treats the wheel A-2-3-4-5 as a 5-high straight', () => {
    const v = evaluate5(parseCards('Ah 2c 3d 4s 5h'))
    expect(categoryOf(v)).toBe(HandCategory.Straight)
    expect(v[1]).toBe(5) // 5 ハイ
    // 6ハイストレートより弱い
    const six = evaluate5(parseCards('2h 3c 4d 5s 6h'))
    expect(compareHand(v, six)).toBeLessThan(0)
  })

  it('detects royal flush', () => {
    expect(isRoyalFlush(evaluate5(parseCards('As Ks Qs Js Ts')))).toBe(true)
    expect(isRoyalFlush(evaluate5(parseCards('Ks Qs Js Ts 9s')))).toBe(false)
  })
})

describe('compareHand ordering', () => {
  it('ranks categories correctly', () => {
    const sf = evaluate5(parseCards('As Ks Qs Js Ts'))
    const quads = evaluate5(parseCards('9h 9c 9d 9s 2c'))
    expect(compareHand(sf, quads)).toBeGreaterThan(0)
  })

  it('breaks ties by kickers', () => {
    const aces1 = evaluate5(parseCards('Ah Ac Kd 5s 3h'))
    const aces2 = evaluate5(parseCards('Ah Ac Qd 5s 3h'))
    expect(compareHand(aces1, aces2)).toBeGreaterThan(0) // K kicker > Q kicker
    const same = evaluate5(parseCards('Ad As Kh 5c 3d'))
    expect(compareHand(aces1, same)).toBe(0)
  })

  it('higher trips beat lower trips', () => {
    const kkk = evaluate5(parseCards('Kh Kc Kd 2s 3h'))
    const qqq = evaluate5(parseCards('Qh Qc Qd As Kh'))
    expect(compareHand(kkk, qqq)).toBeGreaterThan(0)
  })
})

describe('evaluate3 (top row)', () => {
  it('only yields high card, pair, or trips', () => {
    expect(categoryOf(evaluate3(parseCards('Ah Ac Ad')))).toBe(HandCategory.Trips)
    expect(categoryOf(evaluate3(parseCards('Ah Ac Kd')))).toBe(HandCategory.Pair)
    expect(categoryOf(evaluate3(parseCards('Ah Qc Kd')))).toBe(HandCategory.HighCard)
  })

  it('compares top pairs by rank then kicker', () => {
    const qqK = evaluate3(parseCards('Qh Qc Kd'))
    const qqJ = evaluate3(parseCards('Qh Qc Jd'))
    const jjA = evaluate3(parseCards('Jh Jc Ad'))
    expect(compareHand(qqK, qqJ)).toBeGreaterThan(0)
    expect(compareHand(qqJ, jjA)).toBeGreaterThan(0) // QQ beats JJ despite ace kicker
  })
})

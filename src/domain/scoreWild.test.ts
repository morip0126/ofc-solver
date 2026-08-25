// ジョーカーのファウル回避解決（ルームルール: ファウルしない置換の中で最強）の回帰テスト。
import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { HandCategory } from './evaluator'
import { evaluateArrangement, fantasylandCards } from './score'
import { ULTIMATE } from './variants'

describe('joker foul-avoiding resolution', () => {
  it('ドリルの実例: T[Ks X Kc] はトリップスではなくKKペアに解決され、15枚FLになる', () => {
    const ev = evaluateArrangement({
      top: parseCards('Ks X1 Kc'),
      middle: parseCards('Kd Kh 6h Ad 4d'),
      bottom: parseCards('6d 5h 3h 3s 5c'),
    })
    expect(ev.fouled).toBe(false)
    expect(ev.top[0]).toBe(HandCategory.Pair)
    expect(ev.top[1]).toBe(13) // KKペア
    expect(fantasylandCards(ev, ULTIMATE)).toBe(15)
  })

  it('ジョーカーなしの順序違反は従来通りファウル', () => {
    const ev = evaluateArrangement({
      top: parseCards('Qs Qc Qh'),
      middle: parseCards('Kd Kh 6h Ad 4d'),
      bottom: parseCards('6d 5h 3h 3s 5c'),
    })
    expect(ev.fouled).toBe(true)
  })

  it('ミドルのジョーカーもボトム以下に demote される', () => {
    const ev = evaluateArrangement({
      top: parseCards('Qs 8c 2h'),
      middle: parseCards('7s 7h X1 4c 3c'), // 独立最大化なら777トリップス
      bottom: parseCards('9s 9h 8s 8h Kc'), // ツーペア
    })
    expect(ev.fouled).toBe(false)
    // トリップスだとボトムのツーペアを超えるので、ツーペア(77+44)以下へ解決される
    expect(ev.middle[0]).toBeLessThanOrEqual(HandCategory.TwoPair)
    expect(ev.middle[0]).toBe(HandCategory.TwoPair)
  })

  it('どう置換しても順序を満たせない場合はファウル', () => {
    const ev = evaluateArrangement({
      top: parseCards('As X1 Ac'), // 最弱でもAAペア
      middle: parseCards('Kd Kh 6h Qd 4d'), // KKペア（AAペア未満）
      bottom: parseCards('6d 5h 3h 3s 5c'),
    })
    expect(ev.fouled).toBe(true)
  })

  it('ファウルしない盤面ではジョーカーは従来通り最強化される', () => {
    const ev = evaluateArrangement({
      top: parseCards('Qs Qc 2h'),
      middle: parseCards('Kd Kh Ks 4c 3c'),
      bottom: parseCards('9s 9h 8s 8h X1'), // ジョーカーで99 88のフルハウス側へ最大化
    })
    expect(ev.fouled).toBe(false)
    expect(ev.bottom[0]).toBe(HandCategory.FullHouse)
  })
})

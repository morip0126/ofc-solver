// ジョーカーのファウル回避解決（ルームルール: ファウルしない置換の中で最強）の回帰テスト。
import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { HandCategory } from './evaluator'
import { evaluateArrangement, fantasylandCards } from './score'
import { solveBest13, solveFantasyland } from './solver'
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

  it('solveBest13 も demote 配置を発見する（ドリル実例の13枚 → KKトップ15枚FL）', () => {
    const cards = parseCards('Ks X1 Kc Kd Kh 6h Ad 4d 6d 5h 3h 3s 5c')
    const results = solveBest13(cards, ULTIMATE, { topK: 5, fantasylandBonus: 20 })
    // 旧ルール（段ごと独立最大化）ではジョーカー入りトップが demote できず上位に
    // FL 配置が出にくい。新ルールでは少なくとも15枚以上のFL（KKトップ demote や
    // ジョーカーAAトップ等）に非ファウルで到達できるはず。
    const fl = results.find((r) => !r.evaluated.fouled && r.fantasylandCards >= 15)
    expect(fl).toBeDefined()
  })

  it('solveFantasyland でも demote 配置が非ファウルとして扱われる', () => {
    // 14枚FL: ジョーカー含み。全探索が例外なく完走し、非ファウル解を返すこと。
    const cards = parseCards('Ks X1 Kc Kd Kh 6h Ad 4d 6d 5h 3h 3s 5c 2d')
    const results = solveFantasyland(cards, ULTIMATE, { topK: 3 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].evaluated.fouled).toBe(false)
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

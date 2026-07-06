// パイナップル OFC の種類（ノーマル / アルティメット等）の定義。
// 種類ごとの違いは主にファンタジーランド（FL）の突入条件と枚数。ロイヤリティ表は royalties.ts の
// 広く使われている標準表を共有する。
//
// 注意: 現実のルームによって細部（FL枚数・リステイ条件・ロイヤリティ）は異なる。ここでは代表的な
// ルールを実装し、Variant を差し替え可能にしている。

import { HandCategory, type HandValue } from './evaluator'

export interface Variant {
  id: string
  name: { ja: string; en: string }
  /**
   * top ハンドから、次局のファンタジーランドで配られる枚数を返す（0 = FL に入らない）。
   * 呼び出し側はファウルしていない前提で使う。
   */
  fantasylandEntryCards(top: HandValue): number
  /**
   * ファンタジーランド中の手が、次局も FL に留まれる（リステイ）条件を満たすか。
   * 一般に「top がスリーカード」または「bottom がフォーカード以上」。
   */
  fantasylandStay(top: HandValue, _middle: HandValue, bottom: HandValue): boolean
}

/** 共通のリステイ判定: top トリップス、または bottom がクアッズ以上。 */
function staysInFantasyland(top: HandValue, _middle: HandValue, bottom: HandValue): boolean {
  if (top[0] === HandCategory.Trips) return true
  if (bottom[0] === HandCategory.Quads || bottom[0] === HandCategory.StraightFlush) return true
  return false
}

/** ノーマル: top が QQ 以上のペア、またはスリーカードで FL（14枚）。 */
export const NORMAL: Variant = {
  id: 'normal',
  name: { ja: 'ノーマル', en: 'Normal' },
  fantasylandEntryCards(top) {
    if (top[0] === HandCategory.Trips) return 14
    if (top[0] === HandCategory.Pair && top[1] >= 12) return 14
    return 0
  },
  fantasylandStay: staysInFantasyland,
}

/** アルティメット（プログレッシブ FL）: QQ=14, KK=15, AA=16, top トリップス=17 枚。 */
export const ULTIMATE: Variant = {
  id: 'ultimate',
  name: { ja: 'アルティメット', en: 'Ultimate' },
  fantasylandEntryCards(top) {
    if (top[0] === HandCategory.Trips) return 17
    if (top[0] === HandCategory.Pair) {
      if (top[1] === 12) return 14 // QQ
      if (top[1] === 13) return 15 // KK
      if (top[1] === 14) return 16 // AA
    }
    return 0
  },
  fantasylandStay: staysInFantasyland,
}

export const VARIANTS = { normal: NORMAL, ultimate: ULTIMATE } as const
export type VariantId = keyof typeof VARIANTS

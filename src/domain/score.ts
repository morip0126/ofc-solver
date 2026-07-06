// 配列（Arrangement）の評価・ファウル判定・対戦スコアリング。
//
// Arrangement は top(3枚) / middle(5枚) / bottom(5枚)。ファウルは bottom >= middle >= top を満たさない配置。

import type { Card } from './cards'
import { compareHand, evaluate3, evaluate5, type HandValue } from './evaluator'
import { royaltyBottom, royaltyMiddle, royaltyTop } from './royalties'
import type { Variant } from './variants'

export interface Arrangement {
  top: Card[] // 3枚
  middle: Card[] // 5枚
  bottom: Card[] // 5枚
}

export interface EvaluatedArrangement {
  top: HandValue
  middle: HandValue
  bottom: HandValue
  /** bottom >= middle >= top を満たさない（無効な配置）。 */
  fouled: boolean
}

function assertSizes(a: Arrangement): void {
  if (a.top.length !== 3 || a.middle.length !== 5 || a.bottom.length !== 5) {
    throw new Error(
      `invalid arrangement sizes: top=${a.top.length} middle=${a.middle.length} bottom=${a.bottom.length}`,
    )
  }
}

/** 配置を評価し、各段の強さとファウル有無を返す。 */
export function evaluateArrangement(a: Arrangement): EvaluatedArrangement {
  assertSizes(a)
  const top = evaluate3(a.top)
  const middle = evaluate5(a.middle)
  const bottom = evaluate5(a.bottom)
  // bottom は middle 以上、middle は top 以上でなければならない。
  const fouled = compareHand(bottom, middle) < 0 || compareHand(middle, top) < 0
  return { top, middle, bottom, fouled }
}

/** 配置の合計ロイヤリティ（ファウル時は 0）。 */
export function royaltiesTotal(ev: EvaluatedArrangement): number {
  if (ev.fouled) return 0
  return royaltyTop(ev.top) + royaltyMiddle(ev.middle) + royaltyBottom(ev.bottom)
}

/** この配置で次局に入るファンタジーランドの枚数（ファウル時は 0、FL に入らないなら 0）。 */
export function fantasylandCards(ev: EvaluatedArrangement, variant: Variant): number {
  if (ev.fouled) return 0
  return variant.fantasylandEntryCards(ev.top)
}

/**
 * 評価済み配置同士のヘッズアップ・スコア（a 視点の得点）。
 * - 各段勝敗で ±1、3段総取り（スクープ）で追加 ±3。
 * - ロイヤリティ差を加算。
 * - ファウルした側は全段負け扱い（相手にスクープ + 相手のロイヤリティを献上）、自分のロイヤリティは 0。
 */
export function scoreEvaluated(
  a: EvaluatedArrangement,
  b: EvaluatedArrangement,
  _variant: Variant,
): number {
  if (a.fouled && b.fouled) return 0
  if (a.fouled) return -(6 + royaltiesTotal(b))
  if (b.fouled) return 6 + royaltiesTotal(a)

  const cb = Math.sign(compareHand(a.bottom, b.bottom))
  const cm = Math.sign(compareHand(a.middle, b.middle))
  const ct = Math.sign(compareHand(a.top, b.top))
  let points = cb + cm + ct
  if (cb > 0 && cm > 0 && ct > 0) points += 3
  else if (cb < 0 && cm < 0 && ct < 0) points -= 3

  return points + (royaltiesTotal(a) - royaltiesTotal(b))
}

/** 配置同士のヘッズアップ・スコア（a 視点）。 */
export function scorePairwise(a: Arrangement, b: Arrangement, variant: Variant): number {
  return scoreEvaluated(evaluateArrangement(a), evaluateArrangement(b), variant)
}

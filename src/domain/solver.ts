// ソルバー本体。
//
// 提供する機能:
//  1. solveBest13        : 既知の13枚から、ファウルしない最善の配列を全探索で求める（決定論的）。
//  2. estimateEVvsRandom : 完成した配置の、ランダム相手に対する期待得点をモンテカルロ推定。
//  3. rankByEV           : 候補配列を EV で並べ替える（solveBest13 の上位候補を再評価する用途）。
//  4. suggestInitial5    : パイナップル OFC 初手5枚の置き方を推定（楽観的補完 + モンテカルロ）。
//  5. suggestStreet      : 各ストリート（3枚引いて2枚置き1枚捨て）の最善手を推定。
//
// 4,5 は「以降の引きは最適に配置できる」という楽観的補完に基づくヒューリスティック。相手を考慮した
// 厳密な逐次最適化は今後の課題。相対的な手の優劣付けには十分機能する。

import { type Card, remainingDeck, without } from './cards'
import { combinations, shuffle } from './combinatorics'
import {
  type Arrangement,
  type EvaluatedArrangement,
  evaluateArrangement,
  fantasylandCards,
  royaltiesTotal,
  scoreEvaluated,
} from './score'
import type { Variant } from './variants'

export const ROW_CAP = { top: 3, middle: 5, bottom: 5 } as const
export type RowKey = keyof typeof ROW_CAP
const ROWS: readonly RowKey[] = ['top', 'middle', 'bottom']

/** 部分的にカードが置かれた盤面（各段は未完成でもよい）。 */
export interface Board {
  top: Card[]
  middle: Card[]
  bottom: Card[]
}

export interface ScoredArrangement {
  arrangement: Arrangement
  evaluated: EvaluatedArrangement
  royalties: number
  fantasylandCards: number
  /** estimateEVvsRandom / rankByEV を通したときのみ設定される。 */
  ev?: number
}

function objective(s: { royalties: number; fantasylandCards: number }, flBonus: number): number {
  return s.royalties + (s.fantasylandCards > 0 ? flBonus : 0)
}

export interface SolveOptions {
  /** 返す候補数（目的関数の降順の上位）。 */
  topK?: number
  /** ファンタジーランドに入る配列へのボーナス点（目的関数に加算）。 */
  fantasylandBonus?: number
}

/**
 * 既知の13枚から、ファウルしない配列を全探索し、目的関数（ロイヤリティ + FL ボーナス）の高い順に返す。
 * 探索は C(13,3)*C(10,5) = 72,072 通り。
 */
export function solveBest13(
  cards: readonly Card[],
  variant: Variant,
  options: SolveOptions = {},
): ScoredArrangement[] {
  if (cards.length !== 13) throw new Error(`solveBest13 expects 13 cards, got ${cards.length}`)
  const { topK = 5, fantasylandBonus = 0 } = options

  const results: ScoredArrangement[] = []
  for (const top of combinations(cards, 3)) {
    const rest10 = without(cards, top)
    for (const middle of combinations(rest10, 5)) {
      const bottom = without(rest10, middle)
      const arrangement: Arrangement = { top, middle, bottom }
      const evaluated = evaluateArrangement(arrangement)
      if (evaluated.fouled) continue
      results.push({
        arrangement,
        evaluated,
        royalties: royaltiesTotal(evaluated),
        fantasylandCards: fantasylandCards(evaluated, variant),
      })
    }
  }

  results.sort((a, b) => objective(b, fantasylandBonus) - objective(a, fantasylandBonus))
  return results.slice(0, topK)
}

export interface EVOptions {
  iters?: number
  rng?: () => number
  /** 相手の配置ポリシー（既定: ロイヤリティ最善の全探索）。 */
  opponentPolicy?: (cards: Card[], variant: Variant) => EvaluatedArrangement | null
}

function bestRoyaltyOpponent(cards: Card[], variant: Variant): EvaluatedArrangement | null {
  const best = solveBest13(cards, variant, { topK: 1 })[0]
  return best ? best.evaluated : null
}

/**
 * 完成した配置の、ランダムな相手に対する期待得点（ヘッズアップ）をモンテカルロ推定する。
 * dead には相手の見えているカードなど、デッキから除外すべき既知カードを渡す。
 */
export function estimateEVvsRandom(
  arrangement: Arrangement,
  dead: readonly Card[],
  variant: Variant,
  options: EVOptions = {},
): number {
  const { iters = 200, rng = Math.random, opponentPolicy = bestRoyaltyOpponent } = options
  const mine = evaluateArrangement(arrangement)
  const used = [...arrangement.top, ...arrangement.middle, ...arrangement.bottom, ...dead]
  const deck = remainingDeck(used)

  let sum = 0
  let n = 0
  for (let i = 0; i < iters; i++) {
    shuffle(deck, rng)
    const oppCards = deck.slice(0, 13)
    const opp = opponentPolicy(oppCards, variant)
    if (!opp) continue
    sum += scoreEvaluated(mine, opp, variant)
    n++
  }
  return n > 0 ? sum / n : 0
}

/** 候補配列を EV で評価して降順に並べ替える（solveBest13 の上位を再ランクする用途）。 */
export function rankByEV(
  candidates: ScoredArrangement[],
  dead: readonly Card[],
  variant: Variant,
  options: EVOptions = {},
): ScoredArrangement[] {
  const scored = candidates.map((c) => ({
    ...c,
    ev: estimateEVvsRandom(c.arrangement, dead, variant, options),
  }))
  scored.sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0))
  return scored
}

// ---- 部分盤面の補完・推定 ----------------------------------------------------

function boardCards(board: Board): Card[] {
  return [...board.top, ...board.middle, ...board.bottom]
}

function remainingCap(board: Board): Record<RowKey, number> {
  return {
    top: ROW_CAP.top - board.top.length,
    middle: ROW_CAP.middle - board.middle.length,
    bottom: ROW_CAP.bottom - board.bottom.length,
  }
}

function cmpCompletion(s: ScoredArrangement, flBonus: number): number {
  // ファウルは大きく減点し、非ファウルの中では目的関数で比較する。
  return s.evaluated.fouled ? -1000 : objective(s, flBonus)
}

/**
 * 既に置いたカードを固定したまま、freeCards で残りスロットを埋める最善の完成形を全探索で求める。
 * 完成形が13枚になるよう freeCards.length は残りスロット数と一致していなければならない。
 * 非ファウルを優先し、その中でロイヤリティ(+FLボーナス)最大を返す。全てファウルなら最もマシなものを返す。
 */
export function bestCompletion(
  board: Board,
  freeCards: readonly Card[],
  variant: Variant,
  flBonus = 0,
): ScoredArrangement | null {
  const cap = remainingCap(board)
  if (cap.top + cap.middle + cap.bottom !== freeCards.length) {
    throw new Error(
      `freeCards (${freeCards.length}) does not match open slots (${cap.top + cap.middle + cap.bottom})`,
    )
  }

  let best: ScoredArrangement | null = null
  for (const topFill of combinations(freeCards, cap.top)) {
    const rest = without(freeCards, topFill)
    for (const midFill of combinations(rest, cap.middle)) {
      const botFill = without(rest, midFill)
      const arrangement: Arrangement = {
        top: [...board.top, ...topFill],
        middle: [...board.middle, ...midFill],
        bottom: [...board.bottom, ...botFill],
      }
      const evaluated = evaluateArrangement(arrangement)
      const cand: ScoredArrangement = {
        arrangement,
        evaluated,
        royalties: royaltiesTotal(evaluated),
        fantasylandCards: fantasylandCards(evaluated, variant),
      }
      if (!best || cmpCompletion(cand, flBonus) > cmpCompletion(best, flBonus)) best = cand
    }
  }
  return best
}

export interface BoardMetric {
  expRoyalty: number
  flProb: number
  foulProb: number
  /** 総合スコア = 期待ロイヤリティ + flWeight*FL率 - foulWeight*ファウル率。 */
  score: number
}

export interface RankOptions {
  iters?: number
  rng?: () => number
  flWeight?: number
  foulWeight?: number
  /** 補完探索中に FL 配列を優先させる度合い。 */
  completionFlBonus?: number
}

/**
 * 部分盤面の価値を、楽観的補完（残りは最適に置ける前提）のモンテカルロで推定する。
 * 盤面が既に13枚なら決定論的に評価する。
 */
export function evaluateBoard(
  board: Board,
  dead: readonly Card[],
  variant: Variant,
  options: RankOptions = {},
): BoardMetric {
  const {
    iters = 100,
    rng = Math.random,
    flWeight = 6,
    foulWeight = 12,
    completionFlBonus = 8,
  } = options
  const placed = boardCards(board)
  const need = 13 - placed.length
  if (need < 0) throw new Error(`board has more than 13 cards: ${placed.length}`)

  if (need === 0) {
    const evaluated = evaluateArrangement(board as Arrangement)
    const foulProb = evaluated.fouled ? 1 : 0
    const expRoyalty = evaluated.fouled ? 0 : royaltiesTotal(evaluated)
    const flProb = fantasylandCards(evaluated, variant) > 0 ? 1 : 0
    return { expRoyalty, flProb, foulProb, score: expRoyalty + flWeight * flProb - foulWeight * foulProb }
  }

  const deck = remainingDeck([...placed, ...dead])
  let royaltySum = 0
  let flCount = 0
  let foulCount = 0
  let n = 0
  for (let i = 0; i < iters; i++) {
    shuffle(deck, rng)
    const future = deck.slice(0, need)
    const best = bestCompletion(board, future, variant, completionFlBonus)
    if (!best) continue
    n++
    if (best.evaluated.fouled) {
      foulCount++
    } else {
      royaltySum += best.royalties
      if (best.fantasylandCards > 0) flCount++
    }
  }

  const expRoyalty = n > 0 ? royaltySum / n : 0
  const flProb = n > 0 ? flCount / n : 0
  const foulProb = n > 0 ? foulCount / n : 0
  return { expRoyalty, flProb, foulProb, score: expRoyalty + flWeight * flProb - foulWeight * foulProb }
}

export interface BoardSuggestion extends BoardMetric {
  board: Board
  /** ストリート手の場合、捨てたカード。 */
  discarded?: Card
}

function cloneBoard(board: Board): Board {
  return { top: [...board.top], middle: [...board.middle], bottom: [...board.bottom] }
}

/** 初手5枚の全ての置き方（top<=3, middle<=5, bottom<=5, 合計5）を列挙する。 */
export function generateInitialBoards(cards: readonly Card[]): Board[] {
  if (cards.length !== 5) throw new Error(`initial street expects 5 cards, got ${cards.length}`)
  const boards: Board[] = []
  for (let tSize = 0; tSize <= Math.min(ROW_CAP.top, 5); tSize++) {
    for (const top of combinations(cards, tSize)) {
      const rest = without(cards, top)
      for (let mSize = 0; mSize <= Math.min(ROW_CAP.middle, rest.length); mSize++) {
        // bottom は残り全部。bottom 枚数は rest.length - mSize <= 5 なので常に有効。
        for (const middle of combinations(rest, mSize)) {
          const bottom = without(rest, middle)
          boards.push({ top: [...top], middle: [...middle], bottom: [...bottom] })
        }
      }
    }
  }
  return boards
}

/** ストリート手（3枚引いて2枚置き1枚捨て）の全ての置き方を列挙する。 */
export function generateStreetBoards(
  current: Board,
  drawn: readonly Card[],
): { board: Board; discarded: Card }[] {
  if (drawn.length !== 3) throw new Error(`street expects 3 drawn cards, got ${drawn.length}`)
  const out: { board: Board; discarded: Card }[] = []

  for (let d = 0; d < 3; d++) {
    const discarded = drawn[d]
    const kept = drawn.filter((_, i) => i !== d)
    // kept[0], kept[1] を空きのある段へ割り当てる（同一段に2枚置くには空き2以上が必要）。
    for (const r0 of ROWS) {
      const board0 = cloneBoard(current)
      if (board0[r0].length >= ROW_CAP[r0]) continue
      board0[r0].push(kept[0])
      for (const r1 of ROWS) {
        const board1 = cloneBoard(board0)
        if (board1[r1].length >= ROW_CAP[r1]) continue
        board1[r1].push(kept[1])
        out.push({ board: board1, discarded })
      }
    }
  }
  return out
}

/** 初手5枚の置き方を評価し、スコア降順で返す。 */
export function suggestInitial5(
  cards: readonly Card[],
  dead: readonly Card[],
  variant: Variant,
  options: RankOptions = {},
): BoardSuggestion[] {
  const boards = generateInitialBoards(cards)
  const suggestions = boards.map((board) => ({
    board,
    ...evaluateBoard(board, dead, variant, options),
  }))
  suggestions.sort((a, b) => b.score - a.score)
  return suggestions
}

/** ストリート手を評価し、スコア降順で返す。 */
export function suggestStreet(
  current: Board,
  drawn: readonly Card[],
  dead: readonly Card[],
  variant: Variant,
  options: RankOptions = {},
): BoardSuggestion[] {
  const candidates = generateStreetBoards(current, drawn)
  const suggestions = candidates.map(({ board, discarded }) => ({
    board,
    discarded,
    // 捨て札もデッキから除外する。
    ...evaluateBoard(board, [...dead, discarded], variant, options),
  }))
  suggestions.sort((a, b) => b.score - a.score)
  return suggestions
}

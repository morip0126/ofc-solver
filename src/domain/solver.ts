// ソルバー本体。
//
// 提供する機能:
//  1. solveBest13        : 既知の13枚から、ファウルしない最善の配列を全探索で求める（決定論的）。
//  2. solveFantasyland   : FL 中の13〜17枚から最善の13枚配置を全探索（リステイ考慮、決定論的）。
//  3. estimateEVvsRandom : 完成した配置の、ランダム相手（1〜複数）に対する期待得点をモンテカルロ推定。
//  4. rankByEV           : 候補配列を EV で並べ替える（solveBest13 の上位候補を再評価する用途）。
//  5. suggestInitial5    : パイナップル OFC 初手5枚の置き方を推定（楽観的補完 + モンテカルロ）。
//  6. suggestStreet      : 各ストリート（3枚引いて2枚置き1枚捨て）の最善手を推定。
//
// 5,6 は「以降の引きは最適に配置できる」という楽観的補完に基づくヒューリスティック。相手を考慮した
// 厳密な逐次最適化は今後の課題。相対的な手の優劣付けには十分機能する。
//
// ホットパスは fastEval.ts の 24bit パックキーで動く（アロケーション回避・整数比較）。
// 正しさは solver.test.ts の参照実装（combinations + evaluateArrangement）とのクロスチェックで担保。

import { type Card, remainingDeck, without } from './cards'
import { combinations, shuffle } from './combinatorics'
import {
  key3,
  key5,
  royaltyBottomKey,
  royaltyMiddleKey,
  royaltyTopKey,
  unpackHandValue,
} from './fastEval'
import { HandCategory } from './evaluator'
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

// ---- パックキーの共通ヘルパー -------------------------------------------------

interface FiveEntry {
  mask: number
  key: number
  royB: number
  royM: number
}

interface TopEntry {
  mask: number
  key: number
  royT: number
}

// k枚組み合わせのインデックス列挙（コールバック方式・共有バッファでアロケーション回避）。
function forEachIndexCombo(n: number, k: number, cb: (idx: readonly number[]) => void): void {
  if (k < 0 || k > n) return
  const idx: number[] = []
  for (let i = 0; i < k; i++) idx.push(i)
  if (k === 0) {
    cb(idx)
    return
  }
  while (true) {
    cb(idx)
    let i = k - 1
    while (i >= 0 && idx[i] === n - k + i) i--
    if (i < 0) break
    idx[i]++
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1
  }
}

const fiveBuf: Card[] = new Array(5)
const threeBuf: Card[] = new Array(3)

/** cards（n≤17枚）の全5枚組み合わせをキー・ロイヤリティ付きで列挙する。mask はインデックスビット。 */
function prepFives(cards: readonly Card[]): FiveEntry[] {
  const out: FiveEntry[] = []
  forEachIndexCombo(cards.length, 5, (idx) => {
    let mask = 0
    for (let i = 0; i < 5; i++) {
      mask |= 1 << idx[i]
      fiveBuf[i] = cards[idx[i]]
    }
    const key = key5(fiveBuf)
    out.push({ mask, key, royB: royaltyBottomKey(key), royM: royaltyMiddleKey(key) })
  })
  return out
}

/** cards（n≤17枚）の全3枚組み合わせをキー・ロイヤリティ付きで列挙する。 */
function prepTops(cards: readonly Card[]): TopEntry[] {
  const out: TopEntry[] = []
  forEachIndexCombo(cards.length, 3, (idx) => {
    let mask = 0
    for (let i = 0; i < 3; i++) {
      mask |= 1 << idx[i]
      threeBuf[i] = cards[idx[i]]
    }
    const key = key3(threeBuf)
    out.push({ mask, key, royT: royaltyTopKey(key) })
  })
  return out
}

function cardsFromMask(cards: readonly Card[], mask: number): Card[] {
  const out: Card[] = []
  for (let i = 0; i < cards.length; i++) if (mask & (1 << i)) out.push(cards[i])
  return out
}

function buildScored(
  cards: readonly Card[],
  topMask: number,
  midMask: number,
  botMask: number,
  variant: Variant,
): ScoredArrangement {
  const arrangement: Arrangement = {
    top: cardsFromMask(cards, topMask),
    middle: cardsFromMask(cards, midMask),
    bottom: cardsFromMask(cards, botMask),
  }
  const evaluated = evaluateArrangement(arrangement)
  return {
    arrangement,
    evaluated,
    royalties: royaltiesTotal(evaluated),
    fantasylandCards: fantasylandCards(evaluated, variant),
  }
}

export interface SolveOptions {
  /** 返す候補数（目的関数の降順の上位）。 */
  topK?: number
  /** ファンタジーランドに入る配列へのボーナス点（目的関数に加算）。 */
  fantasylandBonus?: number
}

/**
 * 既知の13枚から、ファウルしない配列を全探索し、目的関数（ロイヤリティ + FL ボーナス）の高い順に返す。
 * 探索は C(13,3)*C(10,5) = 72,072 通り（パックキーで枝刈りしつつ列挙）。
 */
export function solveBest13(
  cards: readonly Card[],
  variant: Variant,
  options: SolveOptions = {},
): ScoredArrangement[] {
  if (cards.length !== 13) throw new Error(`solveBest13 expects 13 cards, got ${cards.length}`)
  const { topK = 5, fantasylandBonus = 0 } = options
  const FULL = (1 << 13) - 1

  const fives = prepFives(cards)
  const topsByMask = new Map<number, TopEntry>()
  for (const t of prepTops(cards)) topsByMask.set(t.mask, t)

  // 上位 topK を [obj desc] で保持する小さな挿入ソートリスト。
  const best: { obj: number; topMask: number; midMask: number; botMask: number }[] = []

  const nf = fives.length
  for (let bi = 0; bi < nf; bi++) {
    const b = fives[bi]
    for (let mi = 0; mi < nf; mi++) {
      const m = fives[mi]
      if (b.mask & m.mask) continue
      if (m.key > b.key) continue // middle > bottom はファウル
      const topMask = FULL & ~(b.mask | m.mask)
      const t = topsByMask.get(topMask)!
      if (t.key > m.key) continue // top > middle はファウル
      const roys = b.royB + m.royM + t.royT
      const fl = flEntryFromTopKey(t.key, variant)
      const obj = roys + (fl > 0 ? fantasylandBonus : 0)
      if (best.length === topK && obj <= best[best.length - 1].obj) continue
      insertBest(best, { obj, topMask, midMask: m.mask, botMask: b.mask }, topK)
    }
  }

  return best.map((e) => buildScored(cards, e.topMask, e.midMask, e.botMask, variant))
}

function insertBest<T extends { obj: number }>(list: T[], entry: T, cap: number): void {
  let i = list.length
  while (i > 0 && list[i - 1].obj < entry.obj) i--
  list.splice(i, 0, entry)
  if (list.length > cap) list.pop()
}

/** top キーから FL 突入枚数を求める（unpack は Pair/Trips 時のみで安価）。 */
function flEntryFromTopKey(topKey: number, variant: Variant): number {
  const cat = topKey >>> 20
  if (cat !== HandCategory.Pair && cat !== HandCategory.Trips) return 0
  return variant.fantasylandEntryCards(unpackHandValue(topKey))
}

// ---- ファンタジーランド・ソルバー ---------------------------------------------

/**
 * FL 突入の期待価値（points）。「次のハンドを通常ハンドの代わりに n 枚の FL として
 * 打てること」の差分価値で、リステイ連鎖（リステイ後は14枚と仮定）を織り込む:
 *   Δ(n) = S_FL(n) − S_N,  V(14) = Δ(14)/(1 − pStay(14)),  V(n) = Δ(n) + pStay(n)・V(14)
 * S_FL / S_N は同一の相手モデル（ランダム13枚のロイヤリティ最善配置）に対する期待得点の
 * モンテカルロ実測（S_FL: n毎に220〜1600、S_N: 400ハンド）。相手モデル依存の項は差分で相殺される。
 * 実測: S_N=−8.01, S_FL={14:4.70, 15:8.62, 16:13.75, 17:19.10}
 * pStay は flStay.ts の厳密なリステイ可能性判定 × 各100万ハンドの実測（95%CI ±0.1%、
 * 再計測は flStayRate.test.ts）:
 *   pStay={13:5.9%, 14:10.5%, 15:19.5%, 16:34.7%, 17:54.8%}
 *   （経路の内訳: top トリップス {13:1.1%, 14:4.2%, 15:12.4%, 16:28.1%, 17:49.9%} /
 *     bottom クアッズ以上 {13:5.0%, 14:7.3%, 15:10.0%, 16:13.5%, 17:17.8%}、重複あり）
 * この pStay で再計算した V={14:14.2, 15:19.4, 16:26.7, 17:34.9} は S_FL の測定誤差（±1点程度）
 * の範囲内なので、下のテーブルは従来値を維持している（変更時は CLAUDE.md の EV 検証手順に従うこと）。
 *
 * 注意: 本テーブルは標準52枚デッキ用。ジョーカー入り（54枚）は pStay が大幅に高いため
 * 専用の DEFAULT_FL_VALUES_JOKER を使う（evaluateBoard が jokers オプションで自動選択）。
 */
export const DEFAULT_FL_VALUES: Readonly<Record<number, number>> = {
  14: 14.5,
  15: 18.7,
  16: 26.2,
  17: 34.9,
}

/**
 * ファウルの追加ペナルティ（points）。ファウルすると 3 段負け + スクープ（≒6点）に加えて
 * 相手のロイヤリティを献上する。現実的な相手（ヒューリスティック・プレイ相当）の
 * 非ファウル時平均ロイヤリティ実測 3.51 × 非ファウル率 0.95 を加えた 6 + 3.3 ≈ 9.0。
 */
export const DEFAULT_FOUL_WEIGHT = 9.0

/**
 * ジョーカー2枚入り（54枚デッキ）用の FL 期待価値。導出方法は DEFAULT_FL_VALUES と同一
 * （計測ランナー: flValueRate.test.ts。同ランナーは52枚でも既存値をほぼ再現することを確認済み）。
 * ジョーカー入りは pStay が高くリステイ連鎖が長いため、FL の価値が大幅に大きい。
 * 実測（S_N: 400ハンド、S_FL: n毎に320〜1200、相手8/6ドロー平均で分散低減）:
 *   S_N=−8.17±0.44, S_FL={14:4.54, 15:10.35, 16:15.58, 17:19.94},
 *   pStay={14:37.7%, 15:49.7%, 16:63.9%, 17:77.7%}（flStay.ts の100万ハンド実測）
 *   → Δ={14:12.71, 15:18.52, 16:23.75, 17:28.11}, V(14)=Δ/(1−p14)=20.4（SE≈±0.9）
 */
export const DEFAULT_FL_VALUES_JOKER: Readonly<Record<number, number>> = {
  14: 20.4,
  15: 28.7,
  16: 36.8,
  17: 44.0,
}

/** リステイの目的関数ボーナス既定値 = V(14)（リステイは14枚で継続すると仮定）。 */
export const DEFAULT_STAY_BONUS = DEFAULT_FL_VALUES[14]

/** ジョーカー入りのリステイボーナス既定値 = ジョーカー入りの V(14)。 */
export const DEFAULT_STAY_BONUS_JOKER = DEFAULT_FL_VALUES_JOKER[14]

export interface FantasylandOptions {
  /** リステイ（FL 継続）に与えるボーナス点（目的関数に加算）。既定は V(14) の実測値。 */
  stayBonus?: number
  topK?: number
}

export interface FantasylandResult extends ScoredArrangement {
  /** この配置で FL に留まれるか（top トリップス or bottom クアッズ以上）。 */
  stays: boolean
  /** royalties + stays ? stayBonus : 0。 */
  objective: number
}

/**
 * ファンタジーランド中の手（13〜17枚）から、最善の13枚配置を全探索で求める。
 * 目的関数 = ロイヤリティ + リステイなら stayBonus。ファウルする配置は候補に含めない。
 *
 * 17枚時は C(17,5)^2 ≒ 3,800万ペアを走査するが、パックキーの整数比較のみなので
 * Web Worker 上で1〜2秒程度に収まる。
 */
export function solveFantasyland(
  cards: readonly Card[],
  variant: Variant,
  options: FantasylandOptions = {},
): FantasylandResult[] {
  const n = cards.length
  if (n < 13 || n > 17) throw new Error(`solveFantasyland expects 13..17 cards, got ${n}`)
  const { stayBonus = DEFAULT_STAY_BONUS, topK = 3 } = options

  const fives = prepFives(cards)
  const tops = prepTops(cards)

  // ロイヤリティ付き top（少数）: リステイ文脈ごとの降順リスト。
  const royaltyTops = tops.filter((t) => t.royT > 0)
  const topsByRoyDesc = royaltyTops.slice().sort((a, b) => b.royT - a.royT)
  const topsByObjDesc = royaltyTops
    .slice()
    .sort((a, b) => topObjWithStay(b, stayBonus) - topObjWithStay(a, stayBonus))
  // ロイヤリティ0の top を弱い順に（非ファウルの充填用: 最弱が置ければ十分）。
  const topsAscKey = tops.slice().sort((a, b) => a.key - b.key)

  const best: {
    obj: number
    topMask: number
    midMask: number
    botMask: number
    stays: boolean
  }[] = []

  const nf = fives.length
  for (let bi = 0; bi < nf; bi++) {
    const b = fives[bi]
    const bottomStays = b.key >>> 20 >= HandCategory.Quads
    const royaltyList = bottomStays ? topsByRoyDesc : topsByObjDesc
    for (let mi = 0; mi < nf; mi++) {
      const m = fives[mi]
      if (b.mask & m.mask) continue
      if (m.key > b.key) continue
      const used = b.mask | m.mask

      // 最善の top: ロイヤリティ付き top は目的値降順に並んでいるので、最初に置けたものが最善。
      // （ロイヤリティ0の top の目的値は 0 なので、ロイヤリティ付きが置けるなら常にそちらが勝つ。）
      let bestTop: TopEntry | null = null
      for (const t of royaltyList) {
        if (t.mask & used) continue
        if (t.key > m.key) continue
        bestTop = t
        break
      }
      if (bestTop === null) {
        // ロイヤリティ top を置けない場合、最弱の有効 top（弱い順で最初の空き）で非ファウルに埋める。
        for (const t of topsAscKey) {
          if (t.key > m.key) break // 以降はすべて middle を超える → この (bottom, middle) は不成立
          if (t.mask & used) continue
          bestTop = t
          break
        }
      }
      if (bestTop === null) continue

      const stays = bottomStays || bestTop.key >>> 20 === HandCategory.Trips
      const obj = b.royB + m.royM + bestTop.royT + (stays ? stayBonus : 0)
      if (best.length === topK && obj <= best[best.length - 1].obj) continue
      insertBest(best, { obj, topMask: bestTop.mask, midMask: m.mask, botMask: b.mask, stays }, topK)
    }
  }

  return best.map((e) => {
    const scored = buildScored(cards, e.topMask, e.midMask, e.botMask, variant)
    const stays = variant.fantasylandStay(
      scored.evaluated.top,
      scored.evaluated.middle,
      scored.evaluated.bottom,
    )
    return { ...scored, stays, objective: e.obj }
  })
}

function topObjWithStay(t: TopEntry, stayBonus: number): number {
  return t.royT + (t.key >>> 20 === HandCategory.Trips ? stayBonus : 0)
}

// ---- モンテカルロ EV ----------------------------------------------------------

export interface EVOptions {
  iters?: number
  rng?: () => number
  /** ランダム相手の人数（既定 1 = ヘッズアップ）。 */
  opponents?: number
  /** 相手の配置ポリシー（既定: ロイヤリティ最善の全探索）。 */
  opponentPolicy?: (cards: Card[], variant: Variant) => EvaluatedArrangement | null
  /** ジョーカー2枚入り（54枚デッキ）でプレイしているか。 */
  jokers?: boolean
}

function bestRoyaltyOpponent(cards: Card[], variant: Variant): EvaluatedArrangement | null {
  const best = solveBest13(cards, variant, { topK: 1 })[0]
  return best ? best.evaluated : null
}

/**
 * 完成した配置の、ランダムな相手（1〜複数）に対する期待得点をモンテカルロ推定する。
 * 3人打ちはペアワイズ採点なので、Hero の期待得点は各相手との対戦得点の和。
 * dead には相手の見えているカードなど、デッキから除外すべき既知カードを渡す。
 */
export function estimateEVvsRandom(
  arrangement: Arrangement,
  dead: readonly Card[],
  variant: Variant,
  options: EVOptions = {},
): number {
  const {
    iters = 200,
    rng = Math.random,
    opponents = 1,
    opponentPolicy = bestRoyaltyOpponent,
    jokers = false,
  } = options
  const mine = evaluateArrangement(arrangement)
  const used = [...arrangement.top, ...arrangement.middle, ...arrangement.bottom, ...dead]
  const deck = remainingDeck(used, jokers)
  if (deck.length < 13 * opponents) {
    throw new Error(`not enough cards for ${opponents} random opponents (deck=${deck.length})`)
  }

  let sum = 0
  let n = 0
  for (let i = 0; i < iters; i++) {
    shuffle(deck, rng)
    let total = 0
    let ok = true
    for (let k = 0; k < opponents; k++) {
      const opp = opponentPolicy(deck.slice(k * 13, k * 13 + 13), variant)
      if (!opp) {
        ok = false
        break
      }
      total += scoreEvaluated(mine, opp, variant)
    }
    if (!ok) continue
    sum += total
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

// bestCompletion の内部結果（ホットパスではキーのみ持ち回り、Card 配列は最後に構築する）。
interface CompletionBest {
  score: number
  topFillMask: number
  midFillMask: number
}

/**
 * 既に置いたカードを固定したまま、freeCards で残りスロットを埋める最善の完成形を全探索で求める。
 * 完成形が13枚になるよう freeCards.length は残りスロット数と一致していなければならない。
 * 非ファウルを優先し、その中でロイヤリティ(+FLボーナス)最大を返す。全てファウルなら最もマシなものを返す。
 * flValues を渡すと FL 枚数ごとの価値テーブルでボーナスし、無ければ flBonus のフラット加点。
 */
export function bestCompletion(
  board: Board,
  freeCards: readonly Card[],
  variant: Variant,
  flBonus = 0,
  flValues?: Readonly<Record<number, number>>,
): ScoredArrangement | null {
  const cap = remainingCap(board)
  const nf = freeCards.length
  if (cap.top + cap.middle + cap.bottom !== nf) {
    throw new Error(
      `freeCards (${nf}) does not match open slots (${cap.top + cap.middle + cap.bottom})`,
    )
  }

  // 行バッファ（固定部を先に書き、可変部を組み合わせごとに上書きする）。
  const topBuf: Card[] = board.top.slice()
  topBuf.length = 3
  const midBuf: Card[] = board.middle.slice()
  midBuf.length = 5
  const botBuf: Card[] = board.bottom.slice()
  botBuf.length = 5

  const fixedTopKey = cap.top === 0 ? key3(topBuf) : 0
  const fixedMidKey = cap.middle === 0 ? key5(midBuf) : 0
  const fixedBotKey = cap.bottom === 0 ? key5(botBuf) : 0

  let best: CompletionBest | null = null

  const midAvail: number[] = new Array(nf)
  forEachIndexCombo(nf, cap.top, (topIdx) => {
    let topFillMask = 0
    for (let i = 0; i < cap.top; i++) {
      topFillMask |= 1 << topIdx[i]
      topBuf[board.top.length + i] = freeCards[topIdx[i]]
    }
    const topKey = cap.top === 0 ? fixedTopKey : key3(topBuf)

    // top に使っていない free カードのインデックス一覧。
    let na = 0
    for (let i = 0; i < nf; i++) if (!(topFillMask & (1 << i))) midAvail[na++] = i

    forEachIndexCombo(na, cap.middle, (midIdx) => {
      let midFillMask = 0
      for (let i = 0; i < cap.middle; i++) {
        const fi = midAvail[midIdx[i]]
        midFillMask |= 1 << fi
        midBuf[board.middle.length + i] = freeCards[fi]
      }
      const midKey = cap.middle === 0 ? fixedMidKey : key5(midBuf)

      let bi = board.bottom.length
      for (let i = 0; i < na; i++) {
        const fi = midAvail[i]
        if (!(midFillMask & (1 << fi))) botBuf[bi++] = freeCards[fi]
      }
      const botKey = cap.bottom === 0 ? fixedBotKey : key5(botBuf)

      const fouled = botKey < midKey || midKey < topKey
      let score: number
      if (fouled) {
        score = -1000
      } else {
        const roys = royaltyBottomKey(botKey) + royaltyMiddleKey(midKey) + royaltyTopKey(topKey)
        score = roys
        if (flValues || flBonus !== 0) {
          const flN = flEntryFromTopKey(topKey, variant)
          if (flN > 0) score += flValues ? (flValues[flN] ?? 0) : flBonus
        }
      }
      if (!best || score > best.score) {
        best = { score, topFillMask, midFillMask }
      }
    })
  })

  if (!best) return null
  const chosen: CompletionBest = best
  const topFill = cardsFromMask(freeCards, chosen.topFillMask)
  const midFill = cardsFromMask(freeCards, chosen.midFillMask)
  const botFill = cardsFromMask(
    freeCards,
    ((1 << nf) - 1) & ~(chosen.topFillMask | chosen.midFillMask),
  )
  const arrangement: Arrangement = {
    top: [...board.top, ...topFill],
    middle: [...board.middle, ...midFill],
    bottom: [...board.bottom, ...botFill],
  }
  const evaluated = evaluateArrangement(arrangement)
  return {
    arrangement,
    evaluated,
    royalties: royaltiesTotal(evaluated),
    fantasylandCards: fantasylandCards(evaluated, variant),
  }
}

export interface BoardMetric {
  expRoyalty: number
  flProb: number
  /** FL 突入の期待価値（サンプルごとの V(FL枚数) の平均）。 */
  flEV: number
  foulProb: number
  /** 総合スコア = 期待ロイヤリティ + FL期待価値 - foulWeight*ファウル率。 */
  score: number
}

export interface RankOptions {
  iters?: number
  rng?: () => number
  /**
   * FL 枚数 → 期待価値（points）のテーブル。既定は実測の DEFAULT_FL_VALUES。
   * flWeight を明示指定してテーブルを省略した場合は従来のフラット加点（flWeight×FL率）になる。
   */
  flValues?: Readonly<Record<number, number>>
  /** レガシーのフラット FL ボーナス。flValues 指定時は無視。 */
  flWeight?: number
  /** ファウル率へのペナルティ。既定は実測の DEFAULT_FOUL_WEIGHT。 */
  foulWeight?: number
  /** 補完探索中の FL 加点（レガシー・フラット値）。flValues 指定/既定時は不使用。 */
  completionFlBonus?: number
  /** ジョーカー2枚入り（54枚デッキ）でプレイしているか。 */
  jokers?: boolean
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
    flWeight,
    foulWeight = DEFAULT_FOUL_WEIGHT,
    completionFlBonus,
    jokers = false,
  } = options
  // flWeight を明示指定してテーブル省略ならレガシー動作（フラット加点）。それ以外は実測テーブル
  // （デッキに応じて 52枚用 / ジョーカー入り用を選ぶ）。
  const flValues =
    options.flValues ??
    (flWeight !== undefined ? undefined : jokers ? DEFAULT_FL_VALUES_JOKER : DEFAULT_FL_VALUES)
  const flFlat = flWeight ?? 6
  const flValueOf = (flCards: number): number =>
    flCards > 0 ? (flValues ? (flValues[flCards] ?? 0) : flFlat) : 0
  const completionBonus = completionFlBonus ?? (flValues ? 0 : 8)

  const placed = boardCards(board)
  const need = 13 - placed.length
  if (need < 0) throw new Error(`board has more than 13 cards: ${placed.length}`)

  if (need === 0) {
    const evaluated = evaluateArrangement(board as Arrangement)
    const foulProb = evaluated.fouled ? 1 : 0
    const expRoyalty = evaluated.fouled ? 0 : royaltiesTotal(evaluated)
    const flCards = evaluated.fouled ? 0 : fantasylandCards(evaluated, variant)
    const flEV = flValueOf(flCards)
    return {
      expRoyalty,
      flProb: flCards > 0 ? 1 : 0,
      flEV,
      foulProb,
      score: expRoyalty + flEV - foulWeight * foulProb,
    }
  }

  const deck = remainingDeck([...placed, ...dead], jokers)
  let royaltySum = 0
  let flCount = 0
  let flValueSum = 0
  let foulCount = 0
  let n = 0
  for (let i = 0; i < iters; i++) {
    shuffle(deck, rng)
    const future = deck.slice(0, need)
    const best = bestCompletion(board, future, variant, completionBonus, flValues)
    if (!best) continue
    n++
    if (best.evaluated.fouled) {
      foulCount++
    } else {
      royaltySum += best.royalties
      if (best.fantasylandCards > 0) {
        flCount++
        flValueSum += flValueOf(best.fantasylandCards)
      }
    }
  }

  const expRoyalty = n > 0 ? royaltySum / n : 0
  const flProb = n > 0 ? flCount / n : 0
  const flEV = n > 0 ? flValueSum / n : 0
  const foulProb = n > 0 ? foulCount / n : 0
  return { expRoyalty, flProb, flEV, foulProb, score: expRoyalty + flEV - foulWeight * foulProb }
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

export interface SuggestOptions extends RankOptions {
  /** 荒い1次パス後に本評価へ進める候補数。 */
  refineTopK?: number
  /** 進捗コールバック（0..1）。Worker からの進捗通知用。 */
  onProgress?: (done: number, total: number) => void
}

/**
 * 初手5枚の置き方を評価し、スコア降順で返す。
 * 全232通りを荒いイテレーションで1次評価し、上位のみ本イテレーションで精評価する2段構え。
 */
export function suggestInitial5(
  cards: readonly Card[],
  dead: readonly Card[],
  variant: Variant,
  options: SuggestOptions = {},
): BoardSuggestion[] {
  const { iters = 120, refineTopK = 10, onProgress, ...rest } = options
  const boards = generateInitialBoards(cards)
  const coarseIters = Math.max(8, Math.round(iters / 8))
  const total = boards.length + refineTopK

  const coarse = boards.map((board, i) => {
    onProgress?.(i, total)
    return { board, ...evaluateBoard(board, dead, variant, { ...rest, iters: coarseIters }) }
  })
  coarse.sort((a, b) => b.score - a.score)

  const refined = coarse.slice(0, refineTopK).map((s, i) => {
    onProgress?.(boards.length + i, total)
    return { board: s.board, ...evaluateBoard(s.board, dead, variant, { ...rest, iters }) }
  })
  refined.sort((a, b) => b.score - a.score)
  onProgress?.(total, total)

  // 精評価済みを上位に、残りは荒い評価のまま後ろへ。
  return [...refined, ...coarse.slice(refineTopK)]
}

/** ストリート手を評価し、スコア降順で返す。 */
export function suggestStreet(
  current: Board,
  drawn: readonly Card[],
  dead: readonly Card[],
  variant: Variant,
  options: SuggestOptions = {},
): BoardSuggestion[] {
  const { onProgress, ...rest } = options
  const candidates = generateStreetBoards(current, drawn)
  const suggestions = candidates.map(({ board, discarded }, i) => {
    onProgress?.(i, candidates.length)
    return {
      board,
      discarded,
      // 捨て札もデッキから除外する。
      ...evaluateBoard(board, [...dead, discarded], variant, rest),
    }
  })
  suggestions.sort((a, b) => b.score - a.score)
  onProgress?.(candidates.length, candidates.length)
  return suggestions
}

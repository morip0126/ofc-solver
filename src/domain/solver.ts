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

import { type Card, isJoker, remainingDeck, without } from './cards'
import { combinations, mulberry32, shuffle } from './combinatorics'
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
 * 打てること」の差分価値で、リステイ連鎖を織り込む。**本ルームのルール = リステイ後も
 * 同じ枚数を維持**（17枚FLでリステイすればまた17枚）なので、各 n が独立の連鎖になる:
 *   Δ(n) = S_FL(n) − S_N,  V(n) = Δ(n)/(1 − pStay(n))
 * （リステイ→14枚の標準ルール用の旧値は git 履歴参照: 52枚 {14.5,18.7,26.2,34.9} /
 *   ジョーカー {20.4,28.7,36.8,44.0}）
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
  14: 14.2,
  15: 20.7,
  16: 33.3,
  17: 60.0,
}

/**
 * ファウルの追加ペナルティ（points）。ファウルすると 3 段負け + スクープ（≒6点）に加えて
 * 相手のロイヤリティを献上する。現実的な相手（ヒューリスティック・プレイ相当）の
 * 非ファウル時平均ロイヤリティ実測 3.51 × 非ファウル率 0.95 を加えた 6 + 3.3 ≈ 9.0。
 */
export const DEFAULT_FOUL_WEIGHT = 9.0

/**
 * hindsight（後知恵）モデル用の FL 価値スケール。参考ソルバーのサンプル
 * （Kd Kh 6d 5h 3h の M[KK]/B[653] 配置 = EV 32.9pt / FL 55%）に表示 EV の水準を
 * 合わせる較正値。後知恵メトリクスは FL 到達可能性を実プレイの突入率より高く
 * 見積もるので、それに釣り合う FL 重視の価値付けを使う（実測テーブル×スケール）。
 */
export const HINDSIGHT_FL_SCALE = 2.6

/**
 * combined（既定の複合表示）: 全統計を逐次プレイ（到着順コミット + 下段最適、
 * トップ確定型は品質ブレンド）で測り、
 *   EV = 期待ロイヤリティ + FL価値 − COMBINED_FOUL_WEIGHT×ファウル率
 * とする。FL価値は同枚数維持リステイの実測テーブルそのまま（スケール補正なし）。
 * 参考ソルバー（54枚デッキの逐次シミュレーション。FL内訳 KK7.8% 等の一致で特定）の
 * EV 水準は、このテーブルで自然に再現される（Kd Kh 6d 5h 3h グリッドで検証）。
 */
export const COMBINED_FOUL_WEIGHT = 9

function scaleFlValues(
  base: Readonly<Record<number, number>>,
  scale: number,
): Readonly<Record<number, number>> {
  const out: Record<number, number> = {}
  for (const [k, v] of Object.entries(base)) out[Number(k)] = v * scale
  return out
}

/**
 * ジョーカー2枚入り（54枚デッキ）用の FL 期待価値。導出方法は DEFAULT_FL_VALUES と同一
 * （計測ランナー: flValueRate.test.ts。同ランナーは52枚でも既存値をほぼ再現することを確認済み）。
 * ジョーカー入りは pStay が高くリステイ連鎖が長いため、FL の価値が大幅に大きい。
 * 実測（S_N: 400ハンド、S_FL: n毎に320〜1200、相手8/6ドロー平均で分散低減）:
 *   S_N=−8.17±0.44, S_FL={14:4.54, 15:10.35, 16:15.58, 17:19.94},
 *   pStay={14:37.7%, 15:49.7%, 16:63.9%, 17:77.7%}（flStay.ts の100万ハンド実測）
 *   → Δ={14:12.71, 15:18.52, 16:23.75, 17:28.11}, V(n)=Δ(n)/(1−pStay(n))
 *   （同枚数維持リステイ。V(17)=28.11/0.223=126.1 — トリップスFLは77.7%で17枚連鎖するため
 *     価値が非常に大きい。V(14) の SE≈±0.9、V(17) は 1/(1−p) の増幅で SE≈±5〜7）
 * 重み反復の収束確認: 本テーブル組み込み後に S_N を再計測（600ハンド）すると −7.97±0.40 で、
 * V の再計算値 {14:20.1, 15:28.3, 16:36.4, 17:43.5} は現行値と誤差内（1反復で収束）。
 * EV 検証（flValueAB.test.ts、同一配牌1000ハンドのペア比較、52枚用テーブル流用との対比）:
 *   ΔJ = +1.74±0.46 点/ハンド（p<0.001）で改善を確認。純対戦スコアは +0.06±0.19 と悪化なし、
 *   FL突入 24.9%→30.6%（ファウル 9.9%→13.4% は突入増の対価として見合う）。
 */
export const DEFAULT_FL_VALUES_JOKER: Readonly<Record<number, number>> = {
  14: 20.4,
  15: 36.8,
  16: 65.8,
  17: 126.1,
}

/**
 * リステイの目的関数ボーナス = V(現在のFL枚数)。リステイは同じ枚数を維持するルームルール
 * なので、いま打っているFLの枚数が大きいほどリステイの価値が高い（17枚なら126点）。
 * 13枚FL（参考ルール）は V(14) で近似する。
 */
export function stayBonusFor(flCards: number, jokers: boolean): number {
  const table = jokers ? DEFAULT_FL_VALUES_JOKER : DEFAULT_FL_VALUES
  return table[Math.min(17, Math.max(14, flCards))] ?? table[14]
}

/** 後方互換の既定値（14枚FL相当）。枚数が分かる場面では stayBonusFor を使うこと。 */
export const DEFAULT_STAY_BONUS = DEFAULT_FL_VALUES[14]
export const DEFAULT_STAY_BONUS_JOKER = DEFAULT_FL_VALUES_JOKER[14]

export interface FantasylandOptions {
  /** リステイ（FL 継続）に与えるボーナス点（目的関数に加算）。既定は V(14) の実測値。 */
  stayBonus?: number
  topK?: number
  /**
   * bottom 候補（5枚組の列挙 index、prepFives の順）の走査範囲 [start, end)。
   * Worker 分割用。省略時は全域。範囲ごとの topK を目的値降順にマージすれば全域探索と一致する
   * （solverParallel.test.ts で担保）。
   */
  bottomRange?: readonly [number, number]
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
  // 既定のリステイボーナスは「同枚数維持ルール」に基づき V(現在の枚数)（52枚テーブル）。
  // ジョーカー入りは呼び出し側が stayBonusFor(n, true) を渡すこと（worker は対応済み）。
  const { stayBonus = stayBonusFor(n, false), topK = 3, bottomRange } = options

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
  const biStart = Math.max(0, bottomRange?.[0] ?? 0)
  const biEnd = Math.min(nf, bottomRange?.[1] ?? nf)
  for (let bi = biStart; bi < biEnd; bi++) {
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

/** モンテカルロ EV の統計量。分散 = m2 / (n - 1)、標準誤差 = sqrt(m2 / (n - 1) / n)。 */
export interface EVStats {
  mean: number
  /** 有効反復数。 */
  n: number
  /** 平均まわりの二乗和（Welford の M2）。チャンク統合時は Chan の公式で結合する。 */
  m2: number
}

/**
 * 完成した配置の、ランダムな相手（1〜複数）に対する期待得点をモンテカルロ推定する。
 * 3人打ちはペアワイズ採点なので、Hero の期待得点は各相手との対戦得点の和。
 * dead には相手の見えているカードなど、デッキから除外すべき既知カードを渡す。
 * 平均に加えて信頼区間・並列チャンク統合に使える統計量（n, M2）を返す。
 */
export function estimateEVvsRandomStats(
  arrangement: Arrangement,
  dead: readonly Card[],
  variant: Variant,
  options: EVOptions = {},
): EVStats {
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

  let mean = 0
  let m2 = 0
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
    n++
    const d = total - mean
    mean += d / n
    m2 += d * (total - mean)
  }
  return { mean, n, m2 }
}

/** estimateEVvsRandomStats の平均のみ版（従来 API）。 */
export function estimateEVvsRandom(
  arrangement: Arrangement,
  dead: readonly Card[],
  variant: Variant,
  options: EVOptions = {},
): number {
  return estimateEVvsRandomStats(arrangement, dead, variant, options).mean
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

// bestCompletionChoose の内部結果（bottom も選択制なのでマスクを3つ持つ）。
interface ChooseBest {
  score: number
  topFillMask: number
  midFillMask: number
  botFillMask: number
}

/**
 * bestCompletion の「選べる」版: freeCards が空きマスより多くてもよく、余りは捨てたものとして
 * 非ファウル優先・(ロイヤリティ+FL価値)最大の完成形を全探索する。後知恵（hindsight）モデル用。
 */
export function bestCompletionChoose(
  board: Board,
  freeCards: readonly Card[],
  variant: Variant,
  flValues?: Readonly<Record<number, number>>,
): ScoredArrangement | null {
  const cap = remainingCap(board)
  const nf = freeCards.length
  const slots = cap.top + cap.middle + cap.bottom
  if (nf < slots) throw new Error(`freeCards (${nf}) fewer than open slots (${slots})`)
  if (nf === slots) return bestCompletion(board, freeCards, variant, 0, flValues)

  const topBuf: Card[] = board.top.slice()
  topBuf.length = 3
  const midBuf: Card[] = board.middle.slice()
  midBuf.length = 5
  const botBuf: Card[] = board.bottom.slice()
  botBuf.length = 5

  const fixedTopKey = cap.top === 0 ? key3(topBuf) : 0
  const fixedMidKey = cap.middle === 0 ? key5(midBuf) : 0
  const fixedBotKey = cap.bottom === 0 ? key5(botBuf) : 0

  let best: ChooseBest | null = null
  const midAvail: number[] = new Array(nf)
  const botAvail: number[] = new Array(nf)

  forEachIndexCombo(nf, cap.top, (topIdx) => {
    let topFillMask = 0
    for (let i = 0; i < cap.top; i++) {
      topFillMask |= 1 << topIdx[i]
      topBuf[board.top.length + i] = freeCards[topIdx[i]]
    }
    const topKey = cap.top === 0 ? fixedTopKey : key3(topBuf)

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

      let nb = 0
      for (let i = 0; i < na; i++) {
        const fi = midAvail[i]
        if (!(midFillMask & (1 << fi))) botAvail[nb++] = fi
      }
      forEachIndexCombo(nb, cap.bottom, (botIdx) => {
        let botFillMask = 0
        for (let i = 0; i < cap.bottom; i++) {
          const fi = botAvail[botIdx[i]]
          botFillMask |= 1 << fi
          botBuf[board.bottom.length + i] = freeCards[fi]
        }
        const botKey = cap.bottom === 0 ? fixedBotKey : key5(botBuf)

        const fouled = botKey < midKey || midKey < topKey
        let score: number
        if (fouled) {
          score = -1000
        } else {
          score = royaltyBottomKey(botKey) + royaltyMiddleKey(midKey) + royaltyTopKey(topKey)
          if (flValues) {
            const flN = flEntryFromTopKey(topKey, variant)
            if (flN > 0) score += flValues[flN] ?? 0
          }
        }
        if (!best || score > best.score) {
          best = { score, topFillMask, midFillMask, botFillMask }
        }
      })
    })
  })

  if (!best) return null
  const chosen: ChooseBest = best
  const arrangement: Arrangement = {
    top: [...board.top, ...cardsFromMask(freeCards, chosen.topFillMask)],
    middle: [...board.middle, ...cardsFromMask(freeCards, chosen.midFillMask)],
    bottom: [...board.bottom, ...cardsFromMask(freeCards, chosen.botFillMask)],
  }
  const evaluated = evaluateArrangement(arrangement)
  return {
    arrangement,
    evaluated,
    royalties: royaltiesTotal(evaluated),
    fantasylandCards: fantasylandCards(evaluated, variant),
  }
}

// ---- 方針ロールアウト（policy モデル） -----------------------------------------
// 参考ソルバー互換の逐次シミュレーション: トップを QQ+ のために温存しつつ投機的に
// FL を追いかける実戦的な方針で、1ストリートずつ「3枚引いて2枚置き1枚捨てる」。
// 後知恵を使わないので、コミットの失敗（ファウル）も現実的な頻度で発生する。

export interface BoardMetric {
  expRoyalty: number
  flProb: number
  /** FL 突入の期待価値（サンプルごとの V(FL枚数) の平均）。 */
  flEV: number
  foulProb: number
  /** FL 枚数別の突入率（例: ULTIMATE では 14=QQ, 15=KK, 16=AA, 17=トリップス）。 */
  flBreakdown: Record<number, number>
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
  /**
   * 未来のドローのモデル。
   * 'policy'（既定）: トップを QQ+ のために温存して投機的に FL を追いかける固定方針で、
   *   後知恵なしに1ストリートずつロールアウトする軽量近似。コミットの失敗（ファウル）も
   *   現実的な頻度で織り込まれる。
   * 'rollout': 逐次最適プレイのロールアウト（最重量・最高品質）。各ストリートで
   *   「3枚から2枚置き1枚捨て」の全合法手を内側モンテカルロで採点し、固定方針なしに
   *   その都度最良の手を選んでプレイし切る。トップに置くかどうかも毎回 EV で判断される。
   *   反復1回あたり内側評価が走るため計算コストは policy の数十倍（精度「解析」用）。
   * 'hindsight': 残りストリートで見える全カードを見てから最適に置けたと仮定する後知恵
   *   評価（理想プレイの上限。ファウルは「どう置いても避けられない」場合のみ）。
   * 'streets': 見えるカードから各ストリートで限界価値最低の1枚を捨てたと仮定し、残りを
   *   最適補完するハイブリッド。
   * 'exact': 残りマス数ちょうどを引く旧モデル（選択の自由を無視。回帰検証用）。
   */
  futureModel?: FutureModel
  /** 'rollout' の各ストリート手選択に使う内側モンテカルロの反復数（既定 6）。 */
  rolloutInner?: number
  /**
   * policy/combined のトップ・コミットを攻撃的にする（実験用）: ジョーカーをトップに
   * 投入してペア/トリップスを作りに行き、トリップス化の許容ストリートも広げる。
   * 参考ソルバーのプレイヤー像（トリップスFL重視・高ファウル）の再現用。
   */
  aggressiveTopCommit?: boolean
}

export type FutureModel = 'combined' | 'policy' | 'rollout' | 'hindsight' | 'streets' | 'exact'

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
    completionFlBonus,
    jokers = false,
    futureModel = 'combined',
    aggressiveTopCommit = false,
  } = options
  const foulWeight =
    options.foulWeight ??
    (futureModel === 'combined' ? COMBINED_FOUL_WEIGHT : DEFAULT_FOUL_WEIGHT)
  // flWeight を明示指定してテーブル省略ならレガシー動作（フラット加点）。それ以外は実測テーブル
  // （デッキに応じて 52枚用 / ジョーカー入り用を選ぶ）。hindsight / combined モデルは
  // 参考ソルバーの FL 重視の価値付けに合わせてスケールする。
  const baseFlValues =
    flWeight !== undefined ? undefined : jokers ? DEFAULT_FL_VALUES_JOKER : DEFAULT_FL_VALUES
  const flValues =
    options.flValues ??
    (baseFlValues && futureModel === 'hindsight'
      ? scaleFlValues(baseFlValues, HINDSIGHT_FL_SCALE)
      : baseFlValues)
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
      flBreakdown: flCards > 0 ? { [flCards]: 1 } : {},
      score: expRoyalty + flEV - foulWeight * foulProb,
    }
  }

  const deck = remainingDeck([...placed, ...dead], jokers)
  // 'streets'/'hindsight' モデル: 残り need マスは実プレイでは need/2 ストリートで埋まり、
  // 各ストリートで3枚引いて1枚捨てられる。つまり見えるカードは need より多く、その選択の
  // 自由が FL 率とロイヤリティを押し上げる。
  const streets = futureModel !== 'exact' ? Math.floor(need / 2) : 0
  const extra = need - streets * 2
  const seen = streets * 3 + extra
  const rankCount = new Array<number>(16).fill(0)
  const suitCount: Record<string, number> = { c: 0, d: 0, h: 0, s: 0 }
  // 限界価値: ジョーカーは常にキープ。ペア形成 > ランク > フラッシュ素材の順で重み付け。
  const dropScore = (c: Card): number => {
    if (isJoker(c)) return 1000
    return c.rank + 8 * (rankCount[c.rank] - 1) + (suitCount[c.suit] >= 5 ? 3 : 0)
  }

  // ストリート捨てヒューリスティック: 見える seen 枚から、ストリートごとに限界価値が
  // 最低の1枚を捨てて need 枚に絞る（'streets' の本経路、'hindsight' の代替候補）。
  const buildStreetFuture = (future: Card[]): void => {
    rankCount.fill(0)
    suitCount.c = suitCount.d = suitCount.h = suitCount.s = 0
    for (const c of placed) {
      rankCount[c.rank]++
      if (!isJoker(c)) suitCount[c.suit]++
    }
    for (let k = 0; k < seen; k++) {
      const c = deck[k]
      rankCount[c.rank]++
      if (!isJoker(c)) suitCount[c.suit]++
    }
    let pos = 0
    for (let s = 0; s < streets; s++) {
      const a = deck[pos]
      const b = deck[pos + 1]
      const c = deck[pos + 2]
      pos += 3
      const da = dropScore(a)
      const db = dropScore(b)
      const dc = dropScore(c)
      if (da <= db && da <= dc) future.push(b, c)
      else if (db <= dc) future.push(a, c)
      else future.push(a, b)
    }
    for (let k = 0; k < extra; k++) future.push(deck[pos + k])
  }

  // ---- 後知恵（hindsight）用の候補生成 ----
  const cap = remainingCap(board)
  const topPlacedRank = new Array<number>(16).fill(0)
  for (const c of board.top) topPlacedRank[c.rank]++
  // トップに既に QQ+ のペアが確定しているか（combined でのアーム選択に使う）
  const topLockedFL = topPlacedRank.some((n, r) => r >= 12 && n >= 2)

  /**
   * 'policy' モデル（参考ソルバー互換）: トップは「到着順コミット」——各ストリートで
   * 引いた Q+ のカードを（未来を知らずに）トップへ確保していく投機的 FL チェイス。
   * ミドル/ボトム（とトップの残り埋め）は上手いプレイヤー相当として選択制の最適補完。
   * FL 到達は「Q+ のペアが到着してトップに収まったか」に、ファウルは「コミットした
   * トップを下段が追い越せなかったか」に対応し、どちらも現実的な頻度で発生する。
   */
  const policyCommitBest = (): ScoredArrangement | null => {
    const seenCards = deck.slice(0, seen)
    // dropScore の文脈（盤面 + 見えるカード全体のランク/スート数）を構築
    rankCount.fill(0)
    suitCount.c = suitCount.d = suitCount.h = suitCount.s = 0
    for (const c of placed) {
      rankCount[c.rank]++
      if (!isJoker(c)) suitCount[c.suit]++
    }
    for (const c of seenCards) {
      rankCount[c.rank]++
      if (!isJoker(c)) suitCount[c.suit]++
    }

    const topFill: Card[] = []
    const usedTop = new Set<number>()
    const dropped = new Set<number>()
    let topRoom = cap.top
    const topCnt = new Array<number>(16).fill(0)
    for (const c of board.top) topCnt[c.rank]++
    for (let s = 0; s < streets; s++) {
      const base = s * 3
      const group: number[] = []
      for (let k = base; k < base + 3 && k < seenCards.length; k++) group.push(k)
      let placedTop = 0
      const commit = (k: number): void => {
        topFill.push(seenCards[k])
        usedTop.add(k)
        topCnt[seenCards[k].rank]++
        topRoom--
        placedTop++
      }
      // ペア完成（Q+）→ 単騎（高い順、最後の1枠はペアの相方用に温存）→
      // 単騎で新たにペアが可能になった場合の完成、の順で確保する。
      // トリップス化（3枚目）は第1ストリートのみ（下段を組み立てる時間が残る場合だけ）。
      // 単騎の投機は最終ストリートではしない（相方を引く機会が残っていないため）。
      const lastStreet = s === streets - 1
      const byRank = [...group].sort((a, b) => seenCards[b].rank - seenCards[a].rank)
      // トップの Q+ 単騎/ペアの有無（ジョーカー投入の判定に使う）
      const topHighSingle = (): number => {
        for (let r = 14; r >= 12; r--) if (topCnt[r] === 1) return r
        return 0
      }
      const topAnyPair = (): number => {
        for (let r = 14; r >= 2; r--) if (topCnt[r] === 2) return r
        return 0
      }
      for (let pass = 0; pass < 3; pass++) {
        for (const k of byRank) {
          if (topRoom <= 0 || placedTop >= 2) break
          const c = seenCards[k]
          if (usedTop.has(k)) continue
          if (isJoker(c)) {
            // 攻撃的モード: ジョーカーをトップに投入（Q+単騎→ペア化、ペア→トリップス化、
            // 余裕があれば投機的単騎として温存置き）。
            if (!aggressiveTopCommit) continue
            if (pass !== 1) {
              if (topHighSingle() > 0 || (topAnyPair() > 0 && s < 2)) commit(k)
            } else if (!lastStreet && topRoom >= 2) {
              commit(k)
            }
            continue
          }
          if (c.rank < 12) continue
          if (pass === 1) {
            if (!lastStreet && topRoom >= 2 && topCnt[c.rank] === 0) commit(k)
          } else if (
            topCnt[c.rank] === 1 ||
            (topCnt[c.rank] === 2 && s < (aggressiveTopCommit ? 2 : 1))
          ) {
            commit(k)
          }
        }
      }
    }
    void dropped
    // 残りカードは実ルール通り「各ストリートちょうど1枚捨て」の制約下で最適配置する
    // （トップに2枚コミットした街はその街の残り1枚が強制捨て）。全捨てパターンを列挙し、
    // それぞれ厳密補完して最良を採る。候補間で意味が揃うよう、トップ充足済みの候補も同じ扱い。
    const tempBoard: Board = {
      top: [...board.top, ...topFill],
      middle: board.middle,
      bottom: board.bottom,
    }
    const groupsRest: number[][] = []
    for (let s = 0; s < streets; s++) {
      const base = s * 3
      const rest: number[] = []
      for (let k = base; k < base + 3 && k < seenCards.length; k++) {
        if (!usedTop.has(k)) rest.push(k)
      }
      groupsRest.push(rest)
    }
    const extraIdx: number[] = []
    for (let k = streets * 3; k < seen; k++) extraIdx.push(k)

    let pick: ScoredArrangement | null = null
    let pickScore = -Infinity
    const kept: Card[] = []
    const enumerate = (g: number): void => {
      if (g === groupsRest.length) {
        const baseLen = kept.length
        for (const k of extraIdx) kept.push(seenCards[k])
        if (topFill.length + kept.length === need) {
          const r = bestCompletion(tempBoard, kept, variant, completionBonus, flValues)
          if (r) {
            const sc = r.evaluated.fouled ? -1000 : r.royalties + flValueOf(r.fantasylandCards)
            if (sc > pickScore) {
              pick = r
              pickScore = sc
            }
          }
        }
        kept.length = baseLen
        return
      }
      const rest = groupsRest[g]
      // この街で捨てるのは1枚（トップに2枚コミット済みなら残り全部=1枚が捨て）。
      const keepCount = Math.max(0, rest.length - 1)
      if (keepCount === 0) {
        enumerate(g + 1)
        return
      }
      for (let drop = 0; drop < rest.length; drop++) {
        const baseLen = kept.length
        for (let j = 0; j < rest.length; j++) {
          if (j !== drop) kept.push(seenCards[rest[j]])
        }
        enumerate(g + 1)
        kept.length = baseLen
      }
    }
    enumerate(0)
    return pick
  }
  /** seen 枚を見てからの最善形: FLゴール経路 + ファウル回避経路 + ヒューリスティック経路の最良。 */
  // 'hindsight' モデル: ストリート捨て制約つき後知恵。各ストリートの3枚から1枚捨てる
  // 全パターン（3^streets ≤ 81）を列挙し、それぞれ残りを厳密補完して最良を採る。
  // 「見えるカードをどう使ってもファウルを避けられない」場合だけファウルになる。
  const keptBuf: Card[] = new Array(need)
  // 各ストリートの捨て候補（全列挙）。枝刈り（下位2枚のみ）はFL到達を4pt程度取り
  // こぼすことが計測で分かったため行わない。
  const allowedDrops: number[][] = Array.from({ length: streets }, () => [])
  const buildAllowedDrops = (): void => {
    rankCount.fill(0)
    suitCount.c = suitCount.d = suitCount.h = suitCount.s = 0
    for (const c of placed) {
      rankCount[c.rank]++
      if (!isJoker(c)) suitCount[c.suit]++
    }
    for (let k = 0; k < seen; k++) {
      const c = deck[k]
      rankCount[c.rank]++
      if (!isJoker(c)) suitCount[c.suit]++
    }
    for (let s = 0; s < streets; s++) {
      allowedDrops[s].length = 0
      for (let k = 0; k < 3; k++) allowedDrops[s].push(k)
    }
  }
  const hindsightBest = (): ScoredArrangement | null => {
    buildAllowedDrops()
    let pick: ScoredArrangement | null = null
    let pickScore = -Infinity
    const pat: number[] = new Array(streets).fill(0)
    const walk = (g: number): void => {
      if (g < streets) {
        for (const d of allowedDrops[g]) {
          pat[g] = d
          walk(g + 1)
        }
        return
      }
      let ki = 0
      for (let s = 0; s < streets; s++) {
        const base = s * 3
        for (let k = 0; k < 3; k++) {
          if (k !== pat[s]) keptBuf[ki++] = deck[base + k]
        }
      }
      for (let k = 0; k < extra; k++) keptBuf[ki++] = deck[streets * 3 + k]
      const r = bestCompletion(board, keptBuf, variant, completionBonus, flValues)
      if (!r) return
      const sc = r.evaluated.fouled ? -1000 : r.royalties + flValueOf(r.fantasylandCards)
      if (sc > pickScore) {
        pick = r
        pickScore = sc
      }
    }
    walk(0)
    return pick
  }

  /**
   * 'rollout' モデル: 逐次最適プレイのロールアウト。deck（シャッフル済み）の先頭から
   * 3枚ずつ引き、各ストリートで全合法手（2枚置き1枚捨て）を内側モンテカルロ
   * （futureModel:'streets'、軽量）で採点して最良を選ぶ。固定方針なし・後知恵なし。
   */
  const rolloutInner = options.rolloutInner ?? 16
  const rolloutBest = (): ScoredArrangement | null => {
    const cur: Board = { top: [...board.top], middle: [...board.middle], bottom: [...board.bottom] }
    const curDead: Card[] = [...dead]
    let pos = 0
    let remaining = need
    while (remaining >= 2 && deck.length - pos >= 3) {
      const drawn = [deck[pos], deck[pos + 1], deck[pos + 2]]
      pos += 3
      const cands = generateStreetBoards(cur, drawn)
      let bestIdx = -1
      let bestScore = -Infinity
      // 共通乱数法: この手選択では全候補に同じ「未来の引き」を見せる（比較ノイズを相殺）。
      const stSeed = (rng() * 0x100000000) >>> 0
      for (let ci = 0; ci < cands.length; ci++) {
        const m = evaluateBoard(cands[ci].board, [...curDead, cands[ci].discarded], variant, {
          iters: rolloutInner,
          rng: mulberry32(stSeed),
          flValues,
          foulWeight,
          jokers,
          futureModel: 'streets',
        })
        if (m.score > bestScore) {
          bestScore = m.score
          bestIdx = ci
        }
      }
      if (bestIdx < 0) return null
      const chosen = cands[bestIdx]
      cur.top = chosen.board.top
      cur.middle = chosen.board.middle
      cur.bottom = chosen.board.bottom
      curDead.push(chosen.discarded)
      remaining -= 2
    }
    if (remaining > 0) {
      // 端数（変則盤面の保険）: 残りマスちょうど引いて最適補完
      if (deck.length - pos < remaining) return null
      const r = bestCompletion(cur, deck.slice(pos, pos + remaining), variant, completionBonus, flValues)
      return r
    }
    const arrangement = cur as Arrangement
    const evaluated = evaluateArrangement(arrangement)
    return {
      arrangement,
      evaluated,
      royalties: royaltiesTotal(evaluated),
      fantasylandCards: fantasylandCards(evaluated, variant),
    }
  }

  let royaltySum = 0
  let flCount = 0
  let flValueSum = 0
  let foulCount = 0
  const flCounts: Record<number, number> = {}
  let n = 0
  const future: Card[] = []

  // トップ確定型（combined）の2アーム集計: A=最適（捨てパターン全列挙）/ B=素朴（捨て1本）。
  // ループ後に「詰み型ほど最適寄り」の連続ブレンドで合成する。
  interface LockArm {
    foul: number
    roy: number
    fl: number
    flv: number
    counts: Record<number, number>
  }
  const newArm = (): LockArm => ({ foul: 0, roy: 0, fl: 0, flv: 0, counts: {} })
  const lockA = newArm()
  const lockB = newArm()
  let nLock = 0
  const accumulateArm = (acc: LockArm, r: ScoredArrangement): void => {
    if (r.evaluated.fouled) {
      acc.foul++
      return
    }
    acc.roy += r.royalties
    if (r.fantasylandCards > 0) {
      acc.fl++
      acc.flv += flValueOf(r.fantasylandCards)
      acc.counts[r.fantasylandCards] = (acc.counts[r.fantasylandCards] ?? 0) + 1
    }
  }

  for (let i = 0; i < iters; i++) {
    shuffle(deck, rng)
    let best: ScoredArrangement | null
    if (futureModel === 'combined' && streets > 0 && deck.length >= seen) {
      // 複合表示: FL/ロイヤリティは後知恵の到達可能性、ファウルは逐次プレイ（到着順
      // コミット）で測る。参考ソルバーの表示と同じ構成。ただしトップが既に QQ+ で
      // 確定している盤面は「到達」が自明で後知恵が過大になるため、逐次2アームで測る。
      if (topLockedFL) {
        const a = policyCommitBest()
        future.length = 0
        buildStreetFuture(future)
        const b = bestCompletion(board, future, variant, completionBonus, flValues)
        if (!a || !b) continue
        nLock++
        accumulateArm(lockA, a)
        accumulateArm(lockB, b)
        continue
      }
      const pol = policyCommitBest()
      if (!pol) continue
      n++
      if (pol.evaluated.fouled) foulCount++
      else {
        royaltySum += pol.royalties
        if (pol.fantasylandCards > 0) {
          flCount++
          flValueSum += flValueOf(pol.fantasylandCards)
          flCounts[pol.fantasylandCards] = (flCounts[pol.fantasylandCards] ?? 0) + 1
        }
      }
      continue
    }
    if (futureModel === 'rollout' && need >= 2 && deck.length >= need + Math.floor(need / 2)) {
      best = rolloutBest()
    } else if (futureModel === 'policy' && streets > 0 && deck.length >= seen) {
      best = policyCommitBest()
    } else if (futureModel === 'hindsight' && streets > 0 && deck.length >= seen) {
      best = hindsightBest()
    } else {
      future.length = 0
      if (streets > 0 && deck.length >= seen) {
        buildStreetFuture(future)
      } else {
        for (let k = 0; k < need; k++) future.push(deck[k])
      }
      best = bestCompletion(board, future, variant, completionBonus, flValues)
    }
    if (!best) continue
    n++
    if (best.evaluated.fouled) {
      foulCount++
    } else {
      royaltySum += best.royalties
      if (best.fantasylandCards > 0) {
        flCount++
        flValueSum += flValueOf(best.fantasylandCards)
        flCounts[best.fantasylandCards] = (flCounts[best.fantasylandCards] ?? 0) + 1
      }
    }
  }

  if (nLock > 0) {
    // トップ確定型のブレンド: 最適アームでもファウルが多い「詰み型」ほど最適寄りに、
    // 緩い型は素朴アームを 50% まで混ぜる（実プレイヤーの中位品質の近似。
    // 参考グリッドの T[KK] 系3形状すべてに一致するよう較正した連続関数）。
    const fa = lockA.foul / nLock
    const lam = 0.5 * Math.min(1, Math.max(0, (0.35 - fa) / 0.15))
    const mix = (x: number, y: number) => ((1 - lam) * x + lam * y) / nLock
    const foulProb = mix(lockA.foul, lockB.foul)
    const expRoyalty = mix(lockA.roy, lockB.roy)
    const flProb = mix(lockA.fl, lockB.fl)
    const flEV = mix(lockA.flv, lockB.flv)
    const flBreakdown: Record<number, number> = {}
    for (const k of new Set([...Object.keys(lockA.counts), ...Object.keys(lockB.counts)])) {
      flBreakdown[Number(k)] = mix(lockA.counts[Number(k)] ?? 0, lockB.counts[Number(k)] ?? 0)
    }
    return {
      expRoyalty,
      flProb,
      flEV,
      foulProb,
      flBreakdown,
      score: expRoyalty + flEV - foulWeight * foulProb,
    }
  }

  const expRoyalty = n > 0 ? royaltySum / n : 0
  const flProb = n > 0 ? flCount / n : 0
  const flEV = n > 0 ? flValueSum / n : 0
  const foulProb = n > 0 ? foulCount / n : 0
  const flBreakdown: Record<number, number> = {}
  if (n > 0) for (const [k, v] of Object.entries(flCounts)) flBreakdown[Number(k)] = v / n
  return {
    expRoyalty,
    flProb,
    flEV,
    foulProb,
    flBreakdown,
    score: expRoyalty + flEV - foulWeight * foulProb,
  }
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

// ---- 並列評価用のチャンク API --------------------------------------------------
// Worker プールで候補集合を分割評価するための入口。候補は generateInitialBoards /
// generateStreetBoards の列挙順 index で指定する。seed を与えると全候補が同一の決定論的
// PRNG 列（＝同じ「未来の引き」のセット）で評価される。共通乱数法により候補間比較の
// 分散が消え、順位付けが安定する。候補ごとに独立の PRNG を新規生成するため、どのように
// チャンク分割しても全体の結果が一致する（solverParallel.test.ts で担保）。

export interface CandidateMetric extends BoardMetric {
  /** generateInitialBoards / generateStreetBoards の列挙順 index。 */
  index: number
}

export interface ChunkOptions extends RankOptions {
  /** 候補ごとの決定論的 PRNG のベースシード。省略時は rng（または Math.random）を共有。 */
  seed?: number
  onProgress?: (done: number, total: number) => void
}

/**
 * 候補評価用 PRNG。全候補で同一シード（共通乱数法）: どの候補も同じ「未来の引き」の列で
 * 採点されるため、候補間の差分から抽選運のノイズが相殺され、少ない反復でも順位が安定する。
 * （初手候補は同じ5枚を置くので残り山も同一、ストリート候補も引いた3枚が全て山から除かれる
 * ため残り山が同一になり、シャッフル列を共有すると全候補が完全に同じ未来を見る。）
 */
function candidateRng(seed: number, _index: number): () => number {
  return mulberry32(seed >>> 0)
}

/** 初手候補（generateInitialBoards の index 指定）のチャンク評価。 */
export function evaluateInitialChunk(
  cards: readonly Card[],
  dead: readonly Card[],
  variant: Variant,
  indices: readonly number[],
  options: ChunkOptions = {},
): CandidateMetric[] {
  const { seed, onProgress, ...rest } = options
  const boards = generateInitialBoards(cards)
  const out = indices.map((index, i) => {
    onProgress?.(i, indices.length)
    const rng = seed !== undefined ? candidateRng(seed, index) : rest.rng
    return { index, ...evaluateBoard(boards[index], dead, variant, { ...rest, rng }) }
  })
  onProgress?.(indices.length, indices.length)
  return out
}

/** ストリート候補（generateStreetBoards の index 指定）のチャンク評価。捨て札は dead に含めて評価する。 */
export function evaluateStreetChunk(
  current: Board,
  drawn: readonly Card[],
  dead: readonly Card[],
  variant: Variant,
  indices: readonly number[],
  options: ChunkOptions = {},
): CandidateMetric[] {
  const { seed, onProgress, ...rest } = options
  const candidates = generateStreetBoards(current, drawn)
  const out = indices.map((index, i) => {
    onProgress?.(i, indices.length)
    const { board, discarded } = candidates[index]
    const rng = seed !== undefined ? candidateRng(seed, index) : rest.rng
    return { index, ...evaluateBoard(board, [...dead, discarded], variant, { ...rest, rng }) }
  })
  onProgress?.(indices.length, indices.length)
  return out
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

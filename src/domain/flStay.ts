// ファンタジーランド継続（リステイ）の厳密判定と継続率のモンテカルロ推定。
//
// リステイ条件は variants.ts の共通ルール（top トリップス、または bottom クアッズ以上）。
// 配られた n 枚（13〜17）に対して「リステイできる非ファウル配置が存在するか」は
// 引きに依存しない決定的な性質なので、これを厳密に判定できれば
// 継続率 pStay(n) = P(n枚の配牌がリステイ可能) をモンテカルロで任意精度まで詰められる。
//
// solveFantasyland の全探索（17枚で C(17,5)^2 ≒ 3,800万ペア、1〜2秒）は大規模サンプルに
// 使えないため、ここではリステイ条件に特化した枝刈り判定を実装する:
//   - viaBottom: クアッズ/ストレートフラッシュ候補の bottom を直接列挙し、
//     残りから middle ≤ bottom かつ top ≤ middle が組めるかを確認する。
//   - viaTop: トリップス候補の top を直接列挙し、残りから「トリップス以上」の
//     互いに素な5枚役2つ（middle / bottom）が組めるかを確認する。
// 候補（クアッズ/SF/トリップス）が無いハンドはランク集計だけで即座に否定されるので、
// 1ハンドあたりの平均コストは数μs〜数百μs。正しさは solveFantasyland との
// クロスチェックテスト（flStay.test.ts）で担保する。
//
// 注意: 「リステイ可能なら必ずリステイする」プレイを仮定した継続率である。実際のソルバーは
// 目的関数（ロイヤリティ + stayBonus≈14.5）で選ぶが、リステイ配置よりロイヤリティが
// 14.5 点以上高い非リステイ配置は実質存在しない（クアッズ10点/トリップス10点以上が
// 既に付くため）ので、両者は一致するとみなせる。デッドカードなし（52枚から配る）を仮定。
//
// ジョーカー（54枚デッキ）にも対応: 候補列挙（クアッズ/SF/トリップス）でジョーカーの
// 割り当てを全列挙し、埋め判定は key5/key3 のワイルド対応（段ごとに最強扱い）に乗る。
// 実測継続率（各100万ハンド、95%CI ±0.1%、flStayRate.test.ts で再計測可能）:
//   52枚:           {13: 5.9%, 14: 10.5%, 15: 19.5%, 16: 34.7%, 17: 54.8%}
//   54枚+ジョーカー2: {13: 28.7%, 14: 37.7%, 15: 49.7%, 16: 63.9%, 17: 77.7%}
// ジョーカー1枚で「実カードのトリップス+ジョーカー=bottom クアッズ」が立つため、
// ジョーカー入りでは bottom 経由の継続が支配的になる。
// （ネット記事等の高い継続率はジョーカー入りルールの値であることが多い。）

import { type Card, makeDeck } from './cards'
import { shuffle } from './combinatorics'
import { HandCategory } from './evaluator'
import { key3, key5 } from './fastEval'

export interface StayFeasibility {
  /** top トリップスでリステイできる配置が存在する。 */
  viaTop: boolean
  /** bottom クアッズ以上でリステイできる配置が存在する。 */
  viaBottom: boolean
}

/** k枚組み合わせのインデックス列挙（cb が true を返したら打ち切って true）。 */
function findCombo(n: number, k: number, cb: (idx: readonly number[]) => boolean): boolean {
  if (k < 0 || k > n) return false
  const idx: number[] = []
  for (let i = 0; i < k; i++) idx.push(i)
  if (k === 0) return cb(idx)
  while (true) {
    if (cb(idx)) return true
    let i = k - 1
    while (i >= 0 && idx[i] === n - k + i) i--
    if (i < 0) return false
    idx[i]++
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1
  }
}

const fiveBuf: Card[] = new Array(5)
const threeBuf: Card[] = new Array(3)

/**
 * rest から middle(5枚) ≤ capKey と top(3枚) ≤ middle が組めるか。
 * bottom を固定した後の「非ファウルに埋められるか」の厳密判定。
 */
function canFillMiddleTop(rest: readonly Card[], capKey: number): boolean {
  const n = rest.length
  const others: Card[] = []
  return findCombo(n, 5, (mIdx) => {
    for (let i = 0; i < 5; i++) fiveBuf[i] = rest[mIdx[i]]
    const mKey = key5(fiveBuf)
    if (mKey > capKey) return false
    // middle に使っていないカードから top ≤ middle を探す。
    others.length = 0
    let p = 0
    for (let i = 0; i < n; i++) {
      if (p < 5 && mIdx[p] === i) p++
      else others.push(rest[i])
    }
    return findCombo(others.length, 3, (tIdx) => {
      for (let i = 0; i < 3; i++) threeBuf[i] = others[tIdx[i]]
      return key3(threeBuf) <= mKey
    })
  })
}

/**
 * rest から key ≥ minKey の互いに素な5枚役2つ（middle/bottom）が組めるか。
 * 強い方を bottom に置けばよいので、順序は問わない。
 */
function canFillTwoFives(rest: readonly Card[], minKey: number): boolean {
  const masks: number[] = []
  return findCombo(rest.length, 5, (idx) => {
    for (let i = 0; i < 5; i++) fiveBuf[i] = rest[idx[i]]
    if (key5(fiveBuf) < minKey) return false
    let mask = 0
    for (let i = 0; i < 5; i++) mask |= 1 << idx[i]
    for (const m of masks) if ((m & mask) === 0) return true
    masks.push(mask)
    return false
  })
}

/** cards から indexSet（昇順）のカードを除いた配列。 */
function excluding(cards: readonly Card[], exclude: ReadonlySet<number>): Card[] {
  const out: Card[] = []
  for (let i = 0; i < cards.length; i++) if (!exclude.has(i)) out.push(cards[i])
  return out
}

/** 実カードのランク別インデックスとジョーカーのインデックスを集める。 */
function indexCards(cards: readonly Card[]): { byRank: number[][]; jokers: number[] } {
  const byRank: number[][] = []
  const jokers: number[] = []
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].rank
    if (r === 0) jokers.push(i)
    else (byRank[r] ??= []).push(i)
  }
  return { byRank, jokers }
}

/** bottom クアッズ/ストレートフラッシュでリステイできるか（ジョーカーは欠けの補完に使える）。 */
function checkViaBottom(cards: readonly Card[]): boolean {
  const n = cards.length
  const { byRank, jokers } = indexCards(cards)
  const exclude = new Set<number>()

  // クアッズ候補: 実カード (4-jb) 枚 + ジョーカー jb 枚 + キッカー1枚。
  // 実カードが4枚あってもジョーカーで置き換えると1枚を他の段に回せるため、部分集合を全列挙する。
  for (let r = 14; r >= 2; r--) {
    const idxs = byRank[r]
    if (!idxs) continue
    for (let jb = 0; jb <= Math.min(2, jokers.length); jb++) {
      const need = 4 - jb
      if (idxs.length < need) continue
      const found = findCombo(idxs.length, need, (sel) => {
        for (let k = 0; k < n; k++) {
          const kc = cards[k]
          let kickerRank: number
          if (kc.rank === 0) {
            if (jokers.indexOf(k) < jb) continue // クアッズに使用済みのジョーカー
            kickerRank = r === 14 ? 13 : 14 // 余りジョーカーは最強キッカーとして扱われる
          } else {
            if (kc.rank === r) continue
            kickerRank = kc.rank
          }
          const keyB = (HandCategory.Quads << 20) | (r << 16) | (kickerRank << 12)
          exclude.clear()
          for (let i = 0; i < need; i++) exclude.add(idxs[sel[i]])
          for (let i = 0; i < jb; i++) exclude.add(jokers[i])
          exclude.add(k)
          if (canFillMiddleTop(excluding(cards, exclude), keyB)) return true
        }
        return false
      })
      if (found) return true
    }
  }

  // ストレートフラッシュ候補: スーツ×窓。窓内の実カードから keep 枚を使い、
  // 残り (5-keep) をジョーカーで補う（実カードをあえて外して他の段に回す場合も列挙）。
  for (const suit of ['c', 'd', 'h', 's'] as const) {
    const idxByRank: number[] = []
    for (let i = 0; i < n; i++) {
      const c = cards[i]
      if (c.rank !== 0 && c.suit === suit) idxByRank[c.rank] = i
    }
    for (let high = 14; high >= 5; high--) {
      const presentIdx: number[] = []
      for (let d = 0; d < 5; d++) {
        // high=5 のときはホイール（5,4,3,2,A）。
        const r = high - d === 1 ? 14 : high - d
        const i = idxByRank[r]
        if (i !== undefined) presentIdx.push(i)
      }
      const missing = 5 - presentIdx.length
      if (missing > jokers.length) continue
      const keyB = (HandCategory.StraightFlush << 20) | (high << 16)
      const maxExtra = Math.min(jokers.length - missing, presentIdx.length)
      for (let extra = 0; extra <= maxExtra; extra++) {
        const keep = presentIdx.length - extra
        const jb = missing + extra
        const found = findCombo(presentIdx.length, keep, (sel) => {
          exclude.clear()
          for (let i = 0; i < keep; i++) exclude.add(presentIdx[sel[i]])
          for (let i = 0; i < jb; i++) exclude.add(jokers[i])
          return canFillMiddleTop(excluding(cards, exclude), keyB)
        })
        if (found) return true
      }
    }
  }

  return false
}

/** top トリップスでリステイできるか（ペア+ジョーカー等も含む）。 */
function checkViaTop(cards: readonly Card[]): boolean {
  const { byRank, jokers } = indexCards(cards)
  const exclude = new Set<number>()
  for (let r = 14; r >= 2; r--) {
    const idxs = byRank[r]
    const have = idxs?.length ?? 0
    for (let jt = 0; jt <= Math.min(2, jokers.length); jt++) {
      const need = 3 - jt
      if (have < need) continue
      const keyT = (HandCategory.Trips << 20) | (r << 16)
      // どの実カードを top に使うかで残り（スーツ）が変わるため部分集合を全列挙する。
      const found = findCombo(have, need, (sel) => {
        exclude.clear()
        for (let i = 0; i < need; i++) exclude.add(idxs![sel[i]])
        for (let i = 0; i < jt; i++) exclude.add(jokers[i])
        return canFillTwoFives(excluding(cards, exclude), keyT)
      })
      if (found) return true
    }
  }
  return false
}

/**
 * ファンタジーランドの配牌（13〜17枚）から、リステイできる非ファウル配置が
 * 存在するかを厳密に判定する（リステイ経路の内訳つき）。
 */
export function stayFeasibility(cards: readonly Card[]): StayFeasibility {
  const n = cards.length
  if (n < 13 || n > 17) throw new Error(`stayFeasibility expects 13..17 cards, got ${n}`)
  return { viaTop: checkViaTop(cards), viaBottom: checkViaBottom(cards) }
}

/** リステイできる非ファウル配置が存在するか。 */
export function canStayFantasyland(cards: readonly Card[]): boolean {
  const f = stayFeasibility(cards)
  return f.viaTop || f.viaBottom
}

export interface StayRateOptions {
  iters?: number
  rng?: () => number
  /** ジョーカー2枚入り（54枚デッキ）から配るか。 */
  jokers?: boolean
}

export interface StayRateEstimate {
  /** FL の配牌枚数。 */
  n: number
  iters: number
  /** 継続率の点推定。 */
  stayRate: number
  /** 二項分布に基づく標準誤差（95%CI ≒ ±1.96×se）。 */
  se: number
  /** top トリップス経路でリステイ可能だった割合（viaBottom と重複あり）。 */
  viaTopRate: number
  /** bottom クアッズ以上経路でリステイ可能だった割合。 */
  viaBottomRate: number
}

/**
 * n 枚 FL の継続率をモンテカルロで推定する（52枚から n 枚を一様に配る想定）。
 * 判定は stayFeasibility による厳密判定なので、誤差はサンプリングのみ。
 */
export function estimateFantasylandStayRate(
  n: number,
  options: StayRateOptions = {},
): StayRateEstimate {
  const { iters = 100_000, rng = Math.random, jokers = false } = options
  const deck = makeDeck(jokers)
  let stays = 0
  let viaTop = 0
  let viaBottom = 0
  for (let i = 0; i < iters; i++) {
    shuffle(deck, rng)
    const f = stayFeasibility(deck.slice(0, n))
    if (f.viaTop || f.viaBottom) stays++
    if (f.viaTop) viaTop++
    if (f.viaBottom) viaBottom++
  }
  const p = stays / iters
  return {
    n,
    iters,
    stayRate: p,
    se: Math.sqrt((p * (1 - p)) / iters),
    viaTopRate: viaTop / iters,
    viaBottomRate: viaBottom / iters,
  }
}

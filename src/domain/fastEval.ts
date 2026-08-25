// 高速評価コア。
//
// HandValue（[category, ...tiebreakers] の配列）を 24bit 整数キーにパックし、
// ホットパス（全探索・モンテカルロ・FLソルバー）での配列アロケーションと辞書式比較を避ける。
//
//   key = category << 20 | t1 << 16 | t2 << 12 | t3 << 8 | t4 << 4 | t5
//
// tiebreaker はランク（2..14）なので 4bit に収まる。使わない下位ニブルは 0 埋め。
// 0 埋めにより「短い方の長さまで比較して一致ならタイ」という compareHand の切り詰め比較と
// ファウル判定（middle >= top）の意味論が整数比較で完全に一致する
// （最初の実ニブルで差が付けば 0 埋めは影響せず、全ニブル一致=タイは 0埋め側 <= となり非ファウル）。
//
// 正しさは evaluator.ts / royalties.ts とのクロスチェックテスト（fastEval.test.ts）で担保する。

import { type Card, isJoker, makeDeck } from './cards'
import { HandCategory, type HandValue } from './evaluator'

/** HandValue を 24bit キーにパックする。tiebreakers は最大5つ。 */
export function packHandValue(v: HandValue): number {
  let key = v[0] << 20
  const n = Math.min(v.length - 1, 5)
  for (let i = 1; i <= n; i++) key |= v[i] << (20 - 4 * i)
  return key
}

/** 24bit キーを HandValue に戻す（ランクに 0 は無いので 0 ニブル以降は打ち切り）。 */
export function unpackHandValue(key: number): HandValue {
  const v: HandValue = [key >>> 20]
  for (let shift = 16; shift >= 0; shift -= 4) {
    const nib = (key >>> shift) & 0xf
    if (nib === 0) break
    v.push(nib)
  }
  return v
}

export function keyCategory(key: number): HandCategory {
  return (key >>> 20) as HandCategory
}

// ランク出現数を数えるスクラッチ（毎回の配列アロケーションを避ける）。
const cnt = new Uint8Array(15)

// ストレート窓（high=14..6 の5連続 + high=5 のホイール）のランクビットマスク。
const WINDOW_MASKS: number[] = (() => {
  const w = new Array<number>(15).fill(0)
  for (let high = 6; high <= 14; high++) {
    let m = 0
    for (let d = 0; d < 5; d++) m |= 1 << (high - d)
    w[high] = m
  }
  w[5] = (1 << 14) | (1 << 5) | (1 << 4) | (1 << 3) | (1 << 2)
  return w
})()

// key5Wild 用スクラッチ。
const wcnt = new Uint8Array(15)
const natRanks = new Array<number>(5)

/**
 * ジョーカー（rank=0、j枚）を含む5枚の最強キーを直接構成する。
 * 「ジョーカーはその段の役を最強にするカード」ルール。強いカテゴリから順に成立判定し、
 * 成立したカテゴリ内でタイブレーカーを最大化する。evaluator.ts の置換総当たり参照実装との
 * 同値性は fastEval.test.ts の全数クロスチェックで担保。
 */
function key5Wild(cards: readonly Card[], j: number): number {
  let m = 0
  let sameSuit = true
  let suit: string | null = null
  let rankMask = 0
  let hasDup = false
  for (let i = 0; i < 5; i++) {
    const c = cards[i]
    if (c.rank === 0) continue
    if (suit === null) suit = c.suit
    else if (c.suit !== suit) sameSuit = false
    wcnt[c.rank]++
    if (wcnt[c.rank] > 1) hasDup = true
    rankMask |= 1 << c.rank
    natRanks[m++] = c.rank
  }
  // 降順ソート（m ≤ 4 なので挿入ソートで十分）
  for (let i = 1; i < m; i++) {
    const v = natRanks[i]
    let k = i - 1
    while (k >= 0 && natRanks[k] < v) {
      natRanks[k + 1] = natRanks[k]
      k--
    }
    natRanks[k + 1] = v
  }

  const key = key5WildCore(j, m, sameSuit, rankMask, hasDup)
  for (let i = 0; i < m; i++) wcnt[natRanks[i]] = 0
  return key
}

function key5WildCore(
  j: number,
  m: number,
  sameSuit: boolean,
  rankMask: number,
  hasDup: boolean,
): number {
  // 1) ストレートフラッシュ: 実カードが同一スートで、ある窓に全て収まる（欠けはジョーカー）。
  if (sameSuit && !hasDup) {
    for (let high = 14; high >= 5; high--) {
      if ((rankMask & ~WINDOW_MASKS[high]) === 0) {
        return (HandCategory.StraightFlush << 20) | (high << 16)
      }
    }
  }
  // 2) クアッズ: あるランクの実カード + ジョーカーで4枚（5枚同ランクは作らない）。
  for (let r = 14; r >= 2; r--) {
    if (wcnt[r] < 4 - j) continue
    const jokersLeft = j - Math.max(0, 4 - wcnt[r])
    let kicker = 0
    if (jokersLeft > 0) {
      kicker = r === 14 ? 13 : 14 // 余ったジョーカーが最強キッカーになる
    } else {
      for (let i = 0; i < m; i++) {
        if (natRanks[i] !== r) {
          kicker = natRanks[i]
          break
        }
      }
    }
    return (HandCategory.Quads << 20) | (r << 16) | (kicker << 12)
  }
  // 3) フルハウス: j=1 かつ実カードがちょうど2ペア（高いペアをトリップスに）。
  if (j === 1) {
    let p1 = 0
    let p2 = 0
    for (let r = 14; r >= 2; r--) {
      if (wcnt[r] === 2) {
        if (p1 === 0) p1 = r
        else if (p2 === 0) p2 = r
      }
    }
    if (p1 && p2) return (HandCategory.FullHouse << 20) | (p1 << 16) | (p2 << 12)
  }
  // 4) フラッシュ: ジョーカーはスート内の欠けランクの高い方から埋める。
  if (sameSuit) {
    let key = HandCategory.Flush << 20
    let need = j
    let filled = 0
    for (let r = 14; r >= 2 && filled < 5; r--) {
      if (rankMask & (1 << r)) {
        key |= r << (16 - 4 * filled)
        filled++
      } else if (need > 0) {
        key |= r << (16 - 4 * filled)
        filled++
        need--
      }
    }
    return key
  }
  // 5) ストレート: 実カードのランクが重複なく、ある窓に全て収まる。
  if (!hasDup) {
    for (let high = 14; high >= 5; high--) {
      if ((rankMask & ~WINDOW_MASKS[high]) === 0) {
        return (HandCategory.Straight << 20) | (high << 16)
      }
    }
  }
  // 6) トリップス: あるランクの実カード + ジョーカーで3枚。
  for (let r = 14; r >= 2; r--) {
    if (wcnt[r] < 3 - j) continue
    let k1 = 0
    let k2 = 0
    for (let i = 0; i < m; i++) {
      if (natRanks[i] === r) continue
      if (k1 === 0) k1 = natRanks[i]
      else {
        k2 = natRanks[i]
        break
      }
    }
    return (HandCategory.Trips << 20) | (r << 16) | (k1 << 12) | (k2 << 8)
  }
  // 7) ペア: ここに来るのは j=1 で実カードが全て単独ランクのときのみ
  //    （j=2 は任意の実カードで必ずトリップス以上になる）。
  return (
    (HandCategory.Pair << 20) |
    (natRanks[0] << 16) |
    (natRanks[1] << 12) |
    (natRanks[2] << 8) |
    (natRanks[3] << 4)
  )
}

/** 5枚ハンドを直接 24bit キーに評価する（evaluate5 と同値、アロケーションなし）。 */
export function key5(cards: readonly Card[]): number {
  const c0 = cards[0], c1 = cards[1], c2 = cards[2], c3 = cards[3], c4 = cards[4]
  const jokers =
    (c0.rank === 0 ? 1 : 0) +
    (c1.rank === 0 ? 1 : 0) +
    (c2.rank === 0 ? 1 : 0) +
    (c3.rank === 0 ? 1 : 0) +
    (c4.rank === 0 ? 1 : 0)
  if (jokers > 0) return key5Wild(cards, jokers)
  const isFlush =
    c0.suit === c1.suit && c0.suit === c2.suit && c0.suit === c3.suit && c0.suit === c4.suit

  cnt[c0.rank]++; cnt[c1.rank]++; cnt[c2.rank]++; cnt[c3.rank]++; cnt[c4.rank]++

  // グループ抽出（高ランク優先で走査）
  let quad = 0, trip = 0, pairHi = 0, pairLo = 0
  let k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0
  let uniq = 0, hi = 0, lo = 15
  for (let r = 14; r >= 2; r--) {
    const c = cnt[r]
    if (c === 0) continue
    uniq++
    if (r > hi) hi = r
    if (r < lo) lo = r
    if (c === 4) quad = r
    else if (c === 3) trip = r
    else if (c === 2) {
      if (pairHi === 0) pairHi = r
      else pairLo = r
    } else {
      if (k1 === 0) k1 = r
      else if (k2 === 0) k2 = r
      else if (k3 === 0) k3 = r
      else if (k4 === 0) k4 = r
      else k5 = r
    }
  }
  cnt[c0.rank] = 0; cnt[c1.rank] = 0; cnt[c2.rank] = 0; cnt[c3.rank] = 0; cnt[c4.rank] = 0

  // ストレート判定（5ランクすべて異なる場合のみ）
  let straightHigh = 0
  if (uniq === 5) {
    if (hi - lo === 4) straightHigh = hi
    else if (hi === 14 && k2 === 5) straightHigh = 5 // A-2-3-4-5（k1=14, k2=5, k3=4, k4=3, k5=2）
  }

  if (isFlush && straightHigh) return (HandCategory.StraightFlush << 20) | (straightHigh << 16)
  if (quad) return (HandCategory.Quads << 20) | (quad << 16) | (k1 << 12)
  if (trip && pairHi) return (HandCategory.FullHouse << 20) | (trip << 16) | (pairHi << 12)
  if (isFlush) {
    return (
      (HandCategory.Flush << 20) | (k1 << 16) | (k2 << 12) | (k3 << 8) | (k4 << 4) | k5
    )
  }
  if (straightHigh) return (HandCategory.Straight << 20) | (straightHigh << 16)
  if (trip) return (HandCategory.Trips << 20) | (trip << 16) | (k1 << 12) | (k2 << 8)
  if (pairLo) return (HandCategory.TwoPair << 20) | (pairHi << 16) | (pairLo << 12) | (k1 << 8)
  if (pairHi) {
    return (HandCategory.Pair << 20) | (pairHi << 16) | (k1 << 12) | (k2 << 8) | (k3 << 4)
  }
  return (HandCategory.HighCard << 20) | (k1 << 16) | (k2 << 12) | (k3 << 8) | (k4 << 4) | k5
}

/** 3枚（top）ハンドを直接 24bit キーに評価する（evaluate3 と同値、ジョーカーは最強扱い）。 */
export function key3(cards: readonly Card[]): number {
  const a = cards[0].rank, b = cards[1].rank, c = cards[2].rank
  if (a === 0 || b === 0 || c === 0) {
    // ジョーカーあり: 実カード2枚が同ランクならトリップス、異なれば高い方のペア。
    // ジョーカー2枚なら残り1枚のトリップス（デッキにジョーカーは2枚しかない）。
    let x = 0
    let y = 0
    if (a !== 0) x = a
    if (b !== 0) {
      if (x === 0) x = b
      else y = b
    }
    if (c !== 0) {
      if (x === 0) x = c
      else y = c
    }
    if (y === 0 || x === y) return (HandCategory.Trips << 20) | (x << 16)
    const hi = x > y ? x : y
    const lo = x > y ? y : x
    return (HandCategory.Pair << 20) | (hi << 16) | (lo << 12)
  }
  if (a === b && b === c) return (HandCategory.Trips << 20) | (a << 16)
  if (a === b) return (HandCategory.Pair << 20) | (a << 16) | (c << 12)
  if (a === c) return (HandCategory.Pair << 20) | (a << 16) | (b << 12)
  if (b === c) return (HandCategory.Pair << 20) | (b << 16) | (a << 12)
  // ハイカード: 3ランクを降順に
  let x: number = a, y: number = b, z: number = c, t = 0
  if (x < y) { t = x; x = y; y = t }
  if (y < z) { t = y; y = z; z = t }
  if (x < y) { t = x; x = y; y = t }
  return (HandCategory.HighCard << 20) | (x << 16) | (y << 12) | (z << 8)
}

// ---- 上限つき最大キー（ファウル回避のジョーカー解決） --------------------------
//
// ルームルール: ジョーカーは「ファウルしない置換の中で最強のカード」になる。
// 段単体の key5/key3 は従来通り段内最大化のままとし、盤面レベルの順序制約
// （bottom ≥ middle ≥ top）に合わせた demote はこの bounded 関数で行う。
// 置換総当たり（1枚: ≤52通り / 2枚: ≤C(52,2)通り）だが、呼ばれるのは
// 「独立最大化でファウル、かつその段にジョーカーがある」場合だけ。

const NATURAL_DECK = makeDeck()
const subBuf5 = new Array<Card>(5)
const subBuf3 = new Array<Card>(3)

function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit
}

function forEachSubstitution(
  cards: readonly Card[],
  n: 3 | 5,
  cb: (key: number) => void,
): number {
  const keyFn = n === 5 ? key5 : key3
  const buf = n === 5 ? subBuf5 : subBuf3
  let nat = 0
  for (let i = 0; i < n; i++) if (!isJoker(cards[i])) buf[nat++] = cards[i]
  const jokers = n - nat
  if (jokers === 0) return 0
  if (jokers === 1) {
    for (const s of NATURAL_DECK) {
      let dup = false
      for (let i = 0; i < nat; i++) {
        if (sameCard(buf[i], s)) {
          dup = true
          break
        }
      }
      if (dup) continue
      buf[nat] = s
      cb(keyFn(buf))
    }
  } else if (jokers === 2) {
    for (let a = 0; a < NATURAL_DECK.length; a++) {
      const sa = NATURAL_DECK[a]
      let dupA = false
      for (let i = 0; i < nat; i++) {
        if (sameCard(buf[i], sa)) {
          dupA = true
          break
        }
      }
      if (dupA) continue
      for (let b = a + 1; b < NATURAL_DECK.length; b++) {
        const sb = NATURAL_DECK[b]
        let dupB = false
        for (let i = 0; i < nat; i++) {
          if (sameCard(buf[i], sb)) {
            dupB = true
            break
          }
        }
        if (dupB) continue
        buf[nat] = sa
        buf[nat + 1] = sb
        cb(keyFn(buf))
      }
    }
  } else {
    throw new Error(`unsupported joker count: ${jokers}`)
  }
  return jokers
}

/**
 * 5枚ハンドの「bound 以下で最強」キー。不可能なら -1。
 * ジョーカーなしのハンドにも使える（自身のキーが bound 以下ならそのキー、超えるなら -1）。
 */
export function key5AtMost(cards: readonly Card[], bound: number): number {
  let best = -1
  const jokers = forEachSubstitution(cards, 5, (k) => {
    if (k <= bound && k > best) best = k
  })
  if (jokers === 0) {
    const k = key5(cards)
    return k <= bound ? k : -1
  }
  return best
}

/** 3枚（top）ハンドの「bound 以下で最強」キー。不可能なら -1。 */
export function key3AtMost(cards: readonly Card[], bound: number): number {
  let best = -1
  const jokers = forEachSubstitution(cards, 3, (k) => {
    if (k <= bound && k > best) best = k
  })
  if (jokers === 0) {
    const k = key3(cards)
    return k <= bound ? k : -1
  }
  return best
}

/**
 * ジョーカー入りハンドの「達成可能キー」を昇順・重複なしで列挙する（prep 系の事前計算用）。
 * 列挙ループ内の demote はこの配列への二分探索（keyFloor）で O(log n) になる。
 */
export function achievableKeys(cards: readonly Card[], n: 3 | 5): number[] {
  const set = new Set<number>()
  const jokers = forEachSubstitution(cards, n, (k) => set.add(k))
  if (jokers === 0) throw new Error('achievableKeys expects a hand containing jokers')
  return [...set].sort((a, b) => a - b)
}

/** sorted（昇順）から bound 以下の最大値を返す。無ければ -1。 */
export function keyFloor(sorted: readonly number[], bound: number): number {
  let lo = 0
  let hi = sorted.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= bound) {
      ans = sorted[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

// --- キーからのロイヤリティ（royalties.ts と同じ標準表。クロスチェックテストで同値性を担保） ---

const BOTTOM_ROY = new Int8Array(9)
BOTTOM_ROY[HandCategory.Straight] = 2
BOTTOM_ROY[HandCategory.Flush] = 4
BOTTOM_ROY[HandCategory.FullHouse] = 6
BOTTOM_ROY[HandCategory.Quads] = 10
BOTTOM_ROY[HandCategory.StraightFlush] = 15

const MIDDLE_ROY = new Int8Array(9)
MIDDLE_ROY[HandCategory.Trips] = 2
MIDDLE_ROY[HandCategory.Straight] = 4
MIDDLE_ROY[HandCategory.Flush] = 8
MIDDLE_ROY[HandCategory.FullHouse] = 12
MIDDLE_ROY[HandCategory.Quads] = 20
MIDDLE_ROY[HandCategory.StraightFlush] = 30

const ROYAL_KEY = (HandCategory.StraightFlush << 20) | (14 << 16)

export function royaltyBottomKey(key: number): number {
  if (key === ROYAL_KEY) return 25
  return BOTTOM_ROY[key >>> 20]
}

export function royaltyMiddleKey(key: number): number {
  if (key === ROYAL_KEY) return 50
  return MIDDLE_ROY[key >>> 20]
}

export function royaltyTopKey(key: number): number {
  const cat = key >>> 20
  if (cat === HandCategory.Trips) return 10 + ((key >>> 16) & 0xf) - 2
  if (cat === HandCategory.Pair) {
    const pairRank = (key >>> 16) & 0xf
    return pairRank >= 6 ? pairRank - 5 : 0
  }
  return 0
}

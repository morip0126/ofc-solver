// M3（セル完全解）の Go/No-Go 判定用プローブ。
//   M3_PROBE=1 pnpm vitest run src/domain/m3Probe.test.ts --testTimeout=1200000
// 測るもの:
//  1. 第1St決定後の状態数 |B7|（厳密）
//  2. B7→B9（第2St決定後）の子状態数の平均（厳密・サンプル）
//  3. 全 B7 横断の B9 異なり状態数の推定（衝突サンプリング）
//  4. V3（evaluateBoardEndgameNeed4）の実測スループット（実分布の B9 上）
import { describe, it } from 'vitest'
import { type Card, parseCards, remainingDeck } from './cards'
import { mulberry32 } from './combinatorics'
import { type Board, evaluateBoardEndgameNeed4 } from './solver'
import { ULTIMATE } from './variants'

const RUN = process.env.M3_PROBE === '1'
const START: Board = { top: [], middle: parseCards('Kd Kh'), bottom: parseCards('6d 5h 3h') }

type RankVec = number[] // 長さ15, [0]=joker
const ROWS = ['top', 'middle', 'bottom'] as const
const CAPS = { top: 3, middle: 3, bottom: 2 } // セル初期盤面からの追加可能枚数

function initUnseen(): RankVec {
  const v = new Array<number>(15).fill(0)
  for (const c of remainingDeck([...START.middle, ...START.bottom], true)) v[c.rank]++
  return v
}

function classes3(cnt: RankVec): { r: [number, number, number]; w: number }[] {
  const ranks: number[] = []
  for (let r = 0; r < 15; r++) if (cnt[r] > 0) ranks.push(r)
  const C = (n: number, k: number) =>
    k <= 0 ? 1 : k === 1 ? n : k === 2 ? (n * (n - 1)) / 2 : (n * (n - 1) * (n - 2)) / 6
  const out: { r: [number, number, number]; w: number }[] = []
  for (let i = 0; i < ranks.length; i++)
    for (let j = i; j < ranks.length; j++)
      for (let k = j; k < ranks.length; k++) {
        const [a, b, c] = [ranks[i], ranks[j], ranks[k]]
        let w: number
        if (a === b && b === c) w = C(cnt[a], 3)
        else if (a === b) w = C(cnt[a], 2) * cnt[c]
        else if (b === c) w = cnt[a] * C(cnt[b], 2)
        else w = cnt[a] * cnt[b] * cnt[c]
        if (w > 0) out.push({ r: [a, b, c], w })
      }
  return out
}

/** 追加ランクの行割当状態。added: 行ごとのソート済みランク列。disc: 捨てランクのソート列。 */
type S = { t: number[]; m: number[]; b: number[]; disc: number[] }
const keyOf = (s: S) => `${s.t}|${s.m}|${s.b}|${s.disc}`

/** 1ストリートぶんの遷移（3枚クラス → 2枚配置×1枚捨ての全子状態）。 */
function children(s: S, drawn: [number, number, number]): S[] {
  const out = new Map<string, S>()
  for (let d = 0; d < 3; d++) {
    const disc = drawn[d]
    const keep = drawn.filter((_, i) => i !== d)
    for (const r0 of ROWS)
      for (const r1 of ROWS) {
        const add = { top: 0, middle: 0, bottom: 0 }
        add[r0]++
        add[r1]++
        if (s.t.length + add.top > CAPS.top) continue
        if (s.m.length + add.middle > CAPS.middle) continue
        if (s.b.length + add.bottom > CAPS.bottom) continue
        const ns: S = {
          t: [...s.t],
          m: [...s.m],
          b: [...s.b],
          disc: [...s.disc, disc].sort((x, y) => x - y),
        }
        const push = (row: (typeof ROWS)[number], rank: number) => {
          if (row === 'top') ns.t.push(rank)
          else if (row === 'middle') ns.m.push(rank)
          else ns.b.push(rank)
        }
        push(r0, keep[0])
        push(r1, keep[1])
        ns.t.sort((x, y) => x - y)
        ns.m.sort((x, y) => x - y)
        ns.b.sort((x, y) => x - y)
        out.set(keyOf(ns), ns)
      }
  }
  return [...out.values()]
}

describe.skipIf(!RUN)('M3 probe: state counts and V3 throughput', () => {
  it('counts', () => {
    const u0 = initUnseen()
    const t0 = Date.now()

    // 1. |B7|（第1St決定後の異なり状態）
    const b7 = new Map<string, S>()
    const root: S = { t: [], m: [], b: [], disc: [] }
    for (const dc of classes3(u0)) for (const c of children(root, dc.r)) b7.set(keyOf(c), c)
    console.log(`|B7| = ${b7.size} (${Date.now() - t0}ms)`)

    // 2. B7→B9 の子数（サンプル20）
    const b7list = [...b7.values()]
    const rng = mulberry32(0x33aa)
    let childSum = 0
    const sampleB7: S[] = []
    for (let i = 0; i < 20; i++) sampleB7.push(b7list[Math.floor(rng() * b7list.length)])
    for (const s of sampleB7) {
      const cnt = u0.slice()
      for (const arr of [s.t, s.m, s.b, s.disc]) for (const r of arr) cnt[r]--
      const kids = new Set<string>()
      for (const dc of classes3(cnt)) for (const c of children(s, dc.r)) kids.add(keyOf(c))
      childSum += kids.size
    }
    const avgChildren = childSum / sampleB7.length
    console.log(`avg |B9 children per B7| = ${Math.round(avgChildren)}`)
    console.log(`raw B9 upper bound = ${(b7.size * avgChildren).toExponential(2)}`)

    // 3. 全域 B9 異なり数の推定: ランダムな (B7, drawクラス, 子) を s 本サンプルし、
    //    誕生日衝突から実効サポート N_eff ≈ s(s-1)/(2×衝突数) を推定
    const sampleKeys: string[] = []
    const S_N = 60000
    for (let i = 0; i < S_N; i++) {
      const s = b7list[Math.floor(rng() * b7list.length)]
      const cnt = u0.slice()
      for (const arr of [s.t, s.m, s.b, s.disc]) for (const r of arr) cnt[r]--
      const dcs = classes3(cnt)
      // 重み比例サンプリング（重み合計→ルーレット）
      let tot = 0
      for (const d of dcs) tot += d.w
      let x = rng() * tot
      let pick = dcs[0]
      for (const d of dcs) {
        x -= d.w
        if (x <= 0) {
          pick = d
          break
        }
      }
      const kids = children(s, pick.r)
      sampleKeys.push(keyOf(kids[Math.floor(rng() * kids.length)]))
    }
    const seen = new Map<string, number>()
    let coll = 0
    for (const k of sampleKeys) {
      const c = seen.get(k) ?? 0
      coll += c
      seen.set(k, c + 1)
    }
    const nEff = coll > 0 ? (S_N * (S_N - 1)) / (2 * coll) : Number.POSITIVE_INFINITY
    console.log(`B9 collision sample: ${S_N} draws, ${coll} collisions → N_eff ≈ ${nEff.toExponential(2)}`)

    // 4. V3 スループット（実分布 B9 でサンプル10回）
    const toBoard = (s: S): Board => {
      const suits = ['c', 'd', 'h', 's'] as const
      let si = 0
      const mat = (r: number): Card =>
        r === 0
          ? ({ rank: 0, suit: 'c' } as Card)
          : ({ rank: r as Card['rank'], suit: suits[si++ % 4] } as Card)
      return {
        top: s.t.map(mat),
        middle: [...START.middle, ...s.m.map(mat)],
        bottom: [...START.bottom, ...s.b.map(mat)],
      }
    }
    let v3ms = 0
    let v3n = 0
    for (let i = 0; i < 10; i++) {
      const s = sampleB7[i % sampleB7.length]
      const cnt = u0.slice()
      for (const arr of [s.t, s.m, s.b, s.disc]) for (const r of arr) cnt[r]--
      const dcs = classes3(cnt)
      const pick = dcs[Math.floor(rng() * dcs.length)]
      const kid = children(s, pick.r)[0]
      const board = toBoard(kid)
      const deadRanks = kid.disc
      const deadCards: Card[] = deadRanks
        .filter((r) => r !== 0)
        .map((r, i2) => ({ rank: r as Card['rank'], suit: (['s', 'h', 'd', 'c'] as const)[i2 % 4] }) as Card)
      const t1 = performance.now()
      evaluateBoardEndgameNeed4(board, deadCards, ULTIMATE, { jokers: true })
      v3ms += performance.now() - t1
      v3n++
    }
    console.log(`V3 avg = ${(v3ms / v3n).toFixed(0)}ms over ${v3n} states`)
    console.log(`(total ${Math.round((Date.now() - t0) / 1000)}s)`)
  }, 1_200_000)
})

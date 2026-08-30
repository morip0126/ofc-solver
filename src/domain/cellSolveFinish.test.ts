// M3 フェーズB/C: フェーズAの V2 表から
//   B: V1 = E[第2Stドロー558クラス]( max[配置] V2(B7) ) と最適配置表
//   C: 最適方策の前向き展開で FL率 / ファウル率 / 素点 / FL内訳を厳密確定
//
//   CELL_FINISH=1 pnpm vitest run src/domain/cellSolveFinish.test.ts --testTimeout=14400000
//
// 入力: scratchpad の v2_s{0..3}.tsv（全12630 B7）。出力: 統一3行フォーマット +
// 最適第2ストリート配置表（cellSolution.json）。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Card, parseCards, remainingDeck } from './cards'
import {
  type Board,
  DEFAULT_FL_VALUES_JOKER,
  UNCORRECTED_FL_VALUES_JOKER,
  createNeed4Evaluator,
} from './solver'
import { ULTIMATE } from './variants'

const RUN = process.env.CELL_FINISH === '1'
const SP = process.env.CELL_SP ?? ''

const START: Board = { top: [], middle: parseCards('Kd Kh'), bottom: parseCards('6d 5h 3h') }
const ROWS = ['top', 'middle', 'bottom'] as const
const CAPS = { top: 3, middle: 3, bottom: 2 }

type S = { t: number[]; m: number[]; b: number[]; disc: number[] }
const keyOf = (s: S) => `${s.t}|${s.m}|${s.b}|${s.disc}`

function initUnseen(): number[] {
  const v = new Array<number>(15).fill(0)
  for (const c of remainingDeck([...START.middle, ...START.bottom], true)) v[c.rank]++
  return v
}

function classes3(cnt: readonly number[]): { r: [number, number, number]; w: number }[] {
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

function children(s: S, drawn: readonly [number, number, number]): S[] {
  const out = new Map<string, S>()
  for (let d = 0; d < 3; d++) {
    const disc = drawn[d]
    const keep = [drawn[(d + 1) % 3], drawn[(d + 2) % 3]]
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

function materialize(s: S): { board: Board; dead: Card[] } {
  const SUITS = ['c', 'd', 'h', 's'] as const
  const used = new Map<number, Set<string>>()
  for (const c of [...START.middle, ...START.bottom]) {
    if (!used.has(c.rank)) used.set(c.rank, new Set())
    used.get(c.rank)!.add(c.suit)
  }
  let jokersUsed = 0
  const mat = (r: number): Card => {
    if (r === 0) {
      jokersUsed++
      return { rank: 0, suit: jokersUsed === 1 ? 'c' : 'd' } as Card
    }
    const u = used.get(r) ?? new Set<string>()
    used.set(r, u)
    const suit = SUITS.find((x) => !u.has(x))!
    u.add(suit)
    return { rank: r as Card['rank'], suit } as Card
  }
  return {
    board: {
      top: s.t.map(mat),
      middle: [...START.middle, ...s.m.map(mat)],
      bottom: [...START.bottom, ...s.b.map(mat)],
    },
    dead: s.disc.map(mat),
  }
}

const RANK_CH = '0.23456789TJQKA'
const rankStr = (rs: readonly number[]) => rs.map((r) => (r === 0 ? 'X' : RANK_CH[r])).join('')

describe.skipIf(!RUN || !SP)('cell solve phases B+C (set CELL_FINISH=1 CELL_SP=scratchpad)', () => {
  it('compute V1, optimal street-2 table, and optimal-policy metrics', () => {
    // ---- V2 表の読み込み ----
    const v2 = new Map<string, number>()
    for (let i = 0; i < 4; i++) {
      const f = `${SP}/v2_s${i}.tsv`
      if (!existsSync(f)) throw new Error(`missing ${f}`)
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const p = line.indexOf('\t')
        if (p > 0) v2.set(line.slice(0, p), Number(line.slice(p + 1)))
      }
    }
    console.log(`V2 table: ${v2.size} entries`)
    expect(v2.size).toBe(12630)

    const u0 = initUnseen()
    const root: S = { t: [], m: [], b: [], disc: [] }

    // ---- フェーズB: V1 と最適第2ストリート配置表 ----
    let v1 = 0
    let totW = 0
    const table: {
      drawn: string
      prob: number
      top: string
      middle: string
      bottom: string
      discard: string
      v2: number
    }[] = []
    const picks: { s: S; w: number }[] = []
    for (const dc of classes3(u0)) {
      let best: S | null = null
      let bestV = Number.NEGATIVE_INFINITY
      for (const c of children(root, dc.r)) {
        const v = v2.get(keyOf(c))
        if (v === undefined) throw new Error(`V2 missing for ${keyOf(c)}`)
        if (v > bestV) {
          bestV = v
          best = c
        }
      }
      v1 += bestV * dc.w
      totW += dc.w
      picks.push({ s: best!, w: dc.w })
      table.push({
        drawn: rankStr(dc.r),
        prob: dc.w,
        top: rankStr(best!.t),
        middle: rankStr(best!.m),
        bottom: rankStr(best!.b),
        discard: rankStr(best!.disc),
        v2: bestV,
      })
    }
    v1 /= totW
    console.log(`V1 (第1St固定配置のセル価値) = ${v1.toFixed(4)}`)

    // ---- フェーズC: 最適方策の前向き展開でメトリクス確定 ----
    // 各第2Stドロークラス → 最適B7 → 各第3Stドロークラス → V3スコア最大の子B9(最適) →
    // その B9 の metric（第4・5Stは最適応答）を重み付き平均。
    // B9 の選択は V2 計算と同じ argmax（スコア同値なら同順）なので方策が一致する。
    const ev = createNeed4Evaluator(ULTIMATE, { jokers: true }, { skeletons: 30000, gTables: 120000 })
    const v3memo = new Map<string, number>()
    for (let i = 0; i < 4; i++) {
      const f = `${SP}/b9memo_s${i}.tsv`
      if (!existsSync(f)) continue
      let text = readFileSync(f, 'utf8')
      if (!text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1)
      for (const line of text.split('\n')) {
        const p = line.indexOf('\t')
        if (p > 0) {
          const v = Number(line.slice(p + 1))
          if (Number.isFinite(v)) v3memo.set(line.slice(0, p), v)
        }
      }
    }
    console.log(`V3 memo: ${v3memo.size} entries`)

    const v3score = (kid: S): number => {
      const k = keyOf(kid)
      const hit = v3memo.get(k)
      if (hit !== undefined) return hit
      const { board, dead } = materialize(kid)
      const s = ev.score(board, dead)
      v3memo.set(k, s)
      return s
    }

    let expRoy = 0
    let flProb = 0
    let foulProb = 0
    let flEV = 0
    const flBreak: Record<number, number> = { 14: 0, 15: 0, 16: 0, 17: 0 }
    let outerW = 0
    const t0 = Date.now()
    let done = 0
    for (const { s: b7, w: w1 } of picks) {
      const cnt7 = u0.slice()
      for (const arr of [b7.t, b7.m, b7.b, b7.disc]) for (const r of arr) cnt7[r]--
      let innerW = 0
      let e = { roy: 0, flp: 0, foul: 0, flv: 0, fb: [0, 0, 0, 0] }
      for (const dc of classes3(cnt7)) {
        let best: S | null = null
        let bestV = Number.NEGATIVE_INFINITY
        for (const kid of children(b7, dc.r)) {
          const v = v3score(kid)
          if (v > bestV) {
            bestV = v
            best = kid
          }
        }
        const { board, dead } = materialize(best!)
        const m = ev.metric(board, dead)
        e.roy += m.expRoyalty * dc.w
        e.flp += m.flProb * dc.w
        e.foul += m.foulProb * dc.w
        e.flv += m.flEV * dc.w
        for (let i = 0; i < 4; i++) e.fb[i] += (m.flBreakdown[14 + i] ?? 0) * dc.w
        innerW += dc.w
      }
      expRoy += (e.roy / innerW) * w1
      flProb += (e.flp / innerW) * w1
      foulProb += (e.foul / innerW) * w1
      flEV += (e.flv / innerW) * w1
      for (let i = 0; i < 4; i++) flBreak[14 + i] += (e.fb[i] / innerW) * w1
      outerW += w1
      done++
      if (done % 50 === 0) {
        console.log(`... ${done}/${picks.length} (${Math.round((Date.now() - t0) / 1000)}s)`)
      }
    }
    expRoy /= outerW
    flProb /= outerW
    foulProb /= outerW
    flEV /= outerW
    for (const k of [14, 15, 16, 17]) flBreak[k] /= outerW

    // ---- 統一フォーマット出力（確率は厳密値・ハンド数の概念なし） ----
    const pct = (x: number) => (100 * x).toFixed(2)
    const uncorr = [14, 15, 16, 17].reduce(
      (a, n) => a + flBreak[n] * (UNCORRECTED_FL_VALUES_JOKER[n] ?? 0),
      0,
    )
    const corr = [14, 15, 16, 17].reduce(
      (a, n) => a + flBreak[n] * (DEFAULT_FL_VALUES_JOKER[n] ?? 0),
      0,
    )
    console.log('[cell exact solution: M[KK] B[653] / ultimate / 54枚 / 逐次最適プレー]')
    console.log(`通算成績 ハンド数 ∞(厳密値) / FL突入率 ${pct(flProb)}% / ファウル率 ${pct(foulProb)}%`)
    console.log(
      `素点平均 ${expRoy.toFixed(3)} / FL価値込み平均 ${(expRoy + corr).toFixed(3)} / ` +
        `二重計上FL価値込み平均 ${(expRoy + uncorr).toFixed(3)}`,
    )
    console.log(
      `FL内訳: QQ:${pct(flBreak[14])}% KK:${pct(flBreak[15])}% AA:${pct(flBreak[16])}% tri:${pct(flBreak[17])}%`,
    )
    console.log(`(検算: flEV=${flEV.toFixed(3)} vs corr=${corr.toFixed(3)}, V1=${v1.toFixed(4)})`)

    // ---- 最適第2ストリート配置表を保存 ----
    table.sort((a, b) => b.prob - a.prob)
    writeFileSync(`${SP}/cellSolution.json`, JSON.stringify({ v1, table }, null, 1))
    appendFileSync(
      `${SP}/frontier.txt`,
      `=== cell-exact ===\nFL ${pct(flProb)}% foul ${pct(foulProb)}% roy ${expRoy.toFixed(3)} V1 ${v1.toFixed(4)}\n=== cell-exact done\n`,
    )
    console.log(`optimal street-2 table saved: ${SP}/cellSolution.json (${table.length} rows)`)
  }, 14_400_000)
})

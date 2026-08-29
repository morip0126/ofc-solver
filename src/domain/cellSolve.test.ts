// M3: KKセル完全解ドライバ（フェーズA: 全 B7 状態の V2 を計算して永続化）。
//   CELL_SOLVE_OUT=/path/v2.tsv CELL_SOLVE_FROM=0 CELL_SOLVE_TO=100 \
//     pnpm vitest run src/domain/cellSolve.test.ts --testTimeout=14400000
// 出力: TSV 追記 "b7key\tv2score"。既出キーはスキップ（再起動耐性）。
// V2(B7) = E[第2ドロークラス]( max[2枚配置×捨て] V3(B9) )、V3 は evaluateBoardEndgameNeed4
// （2段厳密・クロスチェック済み）。V3 スコアはプロセス内でグローバルにメモ化される。
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { type Card, parseCards, remainingDeck } from './cards'
import { type Board, evaluateBoardEndgameNeed4 } from './solver'
import { ULTIMATE } from './variants'

const OUT = process.env.CELL_SOLVE_OUT ?? ''
const FROM = Number(process.env.CELL_SOLVE_FROM ?? 0)
const TO = Number(process.env.CELL_SOLVE_TO ?? 0)

const START: Board = { top: [], middle: parseCards('Kd Kh'), bottom: parseCards('6d 5h 3h') }
const ROWS = ['top', 'middle', 'bottom'] as const
const CAPS = { top: 3, middle: 3, bottom: 2 }

type RankVec = number[]
type S = { t: number[]; m: number[]; b: number[]; disc: number[] }
const keyOf = (s: S) => `${s.t}|${s.m}|${s.b}|${s.disc}`

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

/**
 * ランク状態 S を具体的なカードへ実体化する。ランクごとにスートを固定札と衝突しないよう
 * 順繰りに割り当てる（同ランクの物理カードは高々4枚なので必ず割り当て可能。ジョーカーは
 * X1→X2）。スートは評価に影響しない（rankEndgameApplicable が保証）。
 */
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

describe.skipIf(!OUT || TO <= FROM)('cell solve phase A (set CELL_SOLVE_OUT/FROM/TO)', () => {
  it(`solve B7[${FROM}..${TO})`, () => {
    const u0 = initUnseen()
    // B7 全列挙（キー昇順で安定 = メモの局所性も稼ぐ）
    const b7 = new Map<string, S>()
    const root: S = { t: [], m: [], b: [], disc: [] }
    for (const dc of classes3(u0)) for (const c of children(root, dc.r)) b7.set(keyOf(c), c)
    const keys = [...b7.keys()].sort()
    console.log(`|B7| = ${keys.length}`)

    const done = new Set<string>()
    if (existsSync(OUT)) {
      for (const line of readFileSync(OUT, 'utf8').split('\n')) {
        const i = line.indexOf('\t')
        if (i > 0) done.add(line.slice(0, i))
      }
    }

    const v3memo = new Map<string, number>()
    // g テーブル（11枚盤面・山非依存）の呼び出し横断キャッシュ。1 エントリ ~14KB なので
    // 上限で世代交代（局所性はキー昇順処理でおおむね保たれる）。
    const fgCache = new Map<string, unknown>()
    const FG_CAP = Number(process.env.CELL_SOLVE_FG_CAP ?? 80000)
    let v3calls = 0
    let v3hits = 0
    const v3 = (kid: S): number => {
      const k = keyOf(kid)
      const hit = v3memo.get(k)
      if (hit !== undefined) {
        v3hits++
        return hit
      }
      v3calls++
      if (fgCache.size > FG_CAP) fgCache.clear()
      const { board, dead } = materialize(kid)
      const score = evaluateBoardEndgameNeed4(board, dead, ULTIMATE, { jokers: true }, fgCache)
        .score
      v3memo.set(k, score)
      return score
    }

    const t0 = Date.now()
    let doneCount = 0
    for (let bi = FROM; bi < Math.min(TO, keys.length); bi++) {
      const key = keys[bi]
      if (done.has(key)) continue
      const s = b7.get(key)!
      const cnt7 = u0.slice()
      for (const arr of [s.t, s.m, s.b, s.disc]) for (const r of arr) cnt7[r]--
      let acc = 0
      let totW = 0
      for (const dc of classes3(cnt7)) {
        let best = Number.NEGATIVE_INFINITY
        for (const kid of children(s, dc.r)) {
          const v = v3(kid)
          if (v > best) best = v
        }
        acc += best * dc.w
        totW += dc.w
      }
      appendFileSync(OUT, `${key}\t${(acc / totW).toFixed(6)}\n`)
      doneCount++
      if (doneCount % 5 === 0) {
        const el = (Date.now() - t0) / 1000
        console.log(
          `B7 ${bi + 1}/${TO} done=${doneCount} ${(el / doneCount).toFixed(1)}s/B7 ` +
            `v3 calls=${v3calls} hits=${v3hits} memo=${v3memo.size}`,
        )
      }
    }
    console.log(`stripe done: ${doneCount} B7 in ${Math.round((Date.now() - t0) / 1000)}s`)
  }, 14_400_000)
})

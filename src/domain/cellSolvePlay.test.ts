// 完全解の裏取り: 完全解の戦略で逐次プレーし、実測が厳密値（FL 36.68% / ファウル 25.27% /
// 素点 5.960）に統計的に収束するかを確認する（木の構築とは独立な前向きシミュレーション）。
//   第2St = cellSolution.json の最適配置表、第3St = V3（createNeed4Evaluator）の argmax、
//   第4St = need=2 厳密、第5St = 決定論。
//
//   CELL_SOLPLAY_HANDS=1000 CELL_SOLPLAY_SP=<scratchpad or data dir> \
//     pnpm vitest run src/domain/cellSolvePlay.test.ts --testTimeout=14400000
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { type Card, parseCards, remainingDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { type Arrangement, evaluateArrangement, fantasylandCards, royaltiesTotal } from './score'
import {
  type Board,
  DEFAULT_FL_VALUES_JOKER,
  UNCORRECTED_FL_VALUES_JOKER,
  createNeed4Evaluator,
  suggestStreet,
} from './solver'
import { ULTIMATE } from './variants'

const HANDS = Number(process.env.CELL_SOLPLAY_HANDS ?? 0)
const SP = process.env.CELL_SOLPLAY_SP ?? ''
const SEED = Number(process.env.CELL_SOLPLAY_SEED ?? 0x5e11)

const START: Board = { top: [], middle: parseCards('Kd Kh'), bottom: parseCards('6d 5h 3h') }
const ROWS = ['top', 'middle', 'bottom'] as const
const CAPS = { top: 3, middle: 3, bottom: 2 }
type RowK = (typeof ROWS)[number]
type S = { t: number[]; m: number[]; b: number[]; disc: number[] }
const keyOf = (s: S) => `${s.t}|${s.m}|${s.b}|${s.disc}`
const RANK_CH = '0.23456789TJQKA'
const rankStr = (rs: readonly number[]) => rs.map((r) => (r === 0 ? 'X' : RANK_CH[r])).join('')
const parseRanks = (s: string): number[] =>
  [...s].map((ch) => (ch === 'X' ? 0 : RANK_CH.indexOf(ch)))

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
        const ns: S = { t: [...s.t], m: [...s.m], b: [...s.b], disc: [...s.disc, disc].sort((x, y) => x - y) }
        const push = (row: RowK, rank: number) => {
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
    board: { top: s.t.map(mat), middle: [...START.middle, ...s.m.map(mat)], bottom: [...START.bottom, ...s.b.map(mat)] },
    dead: s.disc.map(mat),
  }
}

/** ランク状態の遷移（target）に合わせて、実カードを盤面へ配置し捨て札を返す。 */
function applyTransition(board: Board, s: S, target: S, drawn: Card[]): Card {
  const pool = [...drawn]
  const take = (rank: number): Card => {
    const i = pool.findIndex((c) => c.rank === rank)
    if (i < 0) throw new Error(`card of rank ${rank} not in drawn ${drawn.map((c) => c.rank)}`)
    return pool.splice(i, 1)[0]
  }
  const diff = (before: number[], after: number[]): number[] => {
    const rest = [...before]
    const added: number[] = []
    for (const r of after) {
      const i = rest.indexOf(r)
      if (i >= 0) rest.splice(i, 1)
      else added.push(r)
    }
    return added
  }
  for (const r of diff(s.t, target.t)) board.top.push(take(r))
  for (const r of diff(s.m, target.m)) board.middle.push(take(r))
  for (const r of diff(s.b, target.b)) board.bottom.push(take(r))
  if (pool.length !== 1) throw new Error('transition must consume exactly 2 cards')
  return pool[0]
}

describe.skipIf(HANDS <= 0 || !SP)('play the exact-solution policy (set CELL_SOLPLAY_HANDS / _SP)', () => {
  it('measured stats should converge to the exact values', () => {
    const sol = JSON.parse(readFileSync(`${SP}/cellSolution.json`, 'utf8')) as {
      table: { drawn: string; top: string; middle: string; bottom: string; discard: string }[]
    }
    const table = new Map(sol.table.map((r) => [r.drawn, r]))
    const ev = createNeed4Evaluator(ULTIMATE, { jokers: true }, { skeletons: 30000, gTables: 120000 })
    const rng = mulberry32(SEED)
    const deck = remainingDeck([...START.middle, ...START.bottom], true)

    let fouls = 0
    let roySum = 0
    const entries: Record<number, number> = { 14: 0, 15: 0, 16: 0, 17: 0 }
    const t0 = Date.now()
    for (let h = 0; h < HANDS; h++) {
      shuffle(deck, rng)
      const board: Board = { top: [], middle: [...START.middle], bottom: [...START.bottom] }
      let s: S = { t: [], m: [], b: [], disc: [] }
      const dead: Card[] = []

      // 第2St: 最適配置表
      {
        const drawn = deck.slice(0, 3)
        const key = rankStr([...drawn.map((c) => c.rank)].sort((a, b) => a - b))
        const row = table.get(key)
        if (!row) throw new Error(`no table row for ${key}`)
        const target: S = {
          t: parseRanks(row.top),
          m: parseRanks(row.middle),
          b: parseRanks(row.bottom),
          disc: parseRanks(row.discard),
        }
        dead.push(applyTransition(board, s, target, drawn))
        s = target
      }
      // 第3St: V3 の argmax（完全解と同じ目的関数・同じ評価器）
      {
        const drawn = deck.slice(3, 6)
        const dr = [...drawn.map((c) => c.rank)].sort((a, b) => a - b) as [number, number, number]
        let best: S | null = null
        let bestV = Number.NEGATIVE_INFINITY
        for (const kid of children(s, dr)) {
          const { board: kb, dead: kd } = materialize(kid)
          const v = ev.score(kb, kd)
          if (v > bestV) {
            bestV = v
            best = kid
          }
        }
        dead.push(applyTransition(board, s, best!, drawn))
        s = best!
      }
      // 第4St: need=2 厳密、第5St: 決定論
      for (const [from, to] of [
        [6, 9],
        [9, 12],
      ] as const) {
        const drawn = deck.slice(from, to)
        const sug = suggestStreet(board, drawn, dead, ULTIMATE, { jokers: true, endgameExact: true, iters: 1 })[0]
        board.top = sug.board.top
        board.middle = sug.board.middle
        board.bottom = sug.board.bottom
        if (sug.discarded) dead.push(sug.discarded)
      }
      const final = evaluateArrangement(board as Arrangement)
      if (final.fouled) fouls++
      else {
        roySum += royaltiesTotal(final)
        const fl = fantasylandCards(final, ULTIMATE)
        if (fl > 0) entries[fl]++
      }
      if ((h + 1) % 100 === 0) console.log(`... ${h + 1}/${HANDS} (${Math.round((Date.now() - t0) / 1000)}s)`)
    }
    const pct = (x: number) => ((100 * x) / HANDS).toFixed(1)
    const totalEntries = entries[14] + entries[15] + entries[16] + entries[17]
    const flSum = (t: Readonly<Record<number, number>>) =>
      [14, 15, 16, 17].reduce((a, n) => a + entries[n] * (t[n] ?? 0), 0)
    console.log(`[exact-solution policy play seed=${SEED}]`)
    console.log(`通算成績 ハンド数 ${HANDS} / FL突入率 ${pct(totalEntries)}% / ファウル率 ${pct(fouls)}%`)
    console.log(
      `素点平均 ${(roySum / HANDS).toFixed(2)} / FL価値込み平均 ${((roySum + flSum(DEFAULT_FL_VALUES_JOKER)) / HANDS).toFixed(2)} / ` +
        `二重計上FL価値込み平均 ${((roySum + flSum(UNCORRECTED_FL_VALUES_JOKER)) / HANDS).toFixed(2)}`,
    )
    console.log(`FL内訳: QQ:${pct(entries[14])}% KK:${pct(entries[15])}% AA:${pct(entries[16])}% tri:${pct(entries[17])}%`)
    const se = Math.sqrt((0.3668 * (1 - 0.3668)) / HANDS)
    console.log(
      `厳密値との比較: FL 36.68% (SE ±${(100 * se).toFixed(1)}pt) / ファウル 25.27% / 素点 5.960 → ` +
        `差 FL ${(100 * (totalEntries / HANDS) - 36.68).toFixed(1)}pt, ファウル ${(100 * (fouls / HANDS) - 25.27).toFixed(1)}pt, 素点 ${(roySum / HANDS - 5.96).toFixed(2)}`,
    )
    console.log(`(${Math.round((Date.now() - t0) / 1000)}s)`)
  }, 14_400_000)
})

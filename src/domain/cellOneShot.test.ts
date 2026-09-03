// 損益分岐点 N* の較正（ユーザー発案・2026-09）:
// 「N枚を一気に配って一括最適配置」の期待値が、逐次プレーの厳密値
// V1 = 15.1413（セル完全解、M[KK]B[653]）と等しくなる N を探す。
// 目的関数は完全解と同一: ロイヤリティ + DEFAULT_FL_VALUES_JOKER − ファウル時 -9。
// CRN: 同一シャッフル列の先頭N枚を全Nで共有（N間の差の分散を削減）。
//
//   CELL_ONESHOT_SAMPLES=20000 pnpm vitest run src/domain/cellOneShot.test.ts --testTimeout=14400000
import { describe, it } from 'vitest'
import { parseCards, remainingDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { fantasylandCards } from './score'
import { type Board, DEFAULT_FL_VALUES_JOKER, bestCompletionChoose } from './solver'
import { ULTIMATE } from './variants'

const SAMPLES = Number(process.env.CELL_ONESHOT_SAMPLES ?? 0)
const SEED = Number(process.env.CELL_ONESHOT_SEED ?? 0x0e51)
const FOUL_W = 9
const V1 = 15.1413

const START: Board = { top: [], middle: parseCards('Kd Kh'), bottom: parseCards('6d 5h 3h') }

describe.skipIf(SAMPLES <= 0)('one-shot N calibration vs sequential exact (set CELL_ONESHOT_SAMPLES)', () => {
  it('measure E[best one-shot placement of N cards] for N=8..12', () => {
    const rng = mulberry32(SEED)
    const deck = remainingDeck([...START.middle, ...START.bottom], true)
    const NS = [8, 9, 10, 11, 12]
    const stat = new Map<number, { sum: number; sum2: number; foul: number; roy: number; fl: Record<number, number> }>()
    for (const n of NS) stat.set(n, { sum: 0, sum2: 0, foul: 0, roy: 0, fl: { 14: 0, 15: 0, 16: 0, 17: 0 } })

    const t0 = Date.now()
    for (let s = 0; s < SAMPLES; s++) {
      shuffle(deck, rng)
      for (const n of NS) {
        const st = stat.get(n)!
        const r = bestCompletionChoose(START, deck.slice(0, n), ULTIMATE, DEFAULT_FL_VALUES_JOKER)
        let score: number
        if (!r || r.evaluated.fouled) {
          score = -FOUL_W
          st.foul++
        } else {
          const fl = fantasylandCards(r.evaluated, ULTIMATE)
          score = r.royalties + (fl > 0 ? (DEFAULT_FL_VALUES_JOKER[fl] ?? 0) : 0)
          st.roy += r.royalties
          if (fl > 0) st.fl[fl]++
        }
        st.sum += score
        st.sum2 += score * score
      }
      if ((s + 1) % 2000 === 0) console.log(`... ${s + 1}/${SAMPLES} (${Math.round((Date.now() - t0) / 1000)}s)`)
    }

    const pct = (x: number) => ((100 * x) / SAMPLES).toFixed(2)
    const res: { n: number; mean: number; se: number }[] = []
    for (const n of NS) {
      const st = stat.get(n)!
      const mean = st.sum / SAMPLES
      const se = Math.sqrt(Math.max(0, st.sum2 / SAMPLES - mean * mean) / SAMPLES)
      const flTot = st.fl[14] + st.fl[15] + st.fl[16] + st.fl[17]
      res.push({ n, mean, se })
      console.log(`[one-shot N=${n}]`)
      console.log(`通算成績 ハンド数 ${SAMPLES} / FL突入率 ${pct(flTot)}% / ファウル率 ${pct(st.foul)}%`)
      console.log(
        `素点平均 ${(st.roy / SAMPLES).toFixed(3)} / FL価値込み平均 ${mean >= 0 ? '' : ''}${(st.sum / SAMPLES + (FOUL_W * st.foul) / SAMPLES).toFixed(3)} / スコア平均 ${mean.toFixed(3)} ± ${se.toFixed(3)}`,
      )
      console.log(`FL内訳: QQ:${pct(st.fl[14])}% KK:${pct(st.fl[15])}% AA:${pct(st.fl[16])}% tri:${pct(st.fl[17])}%`)
    }
    // V1 を跨ぐ隣接ペアで線形補間
    for (let i = 0; i + 1 < res.length; i++) {
      const a = res[i]
      const b = res[i + 1]
      if ((a.mean - V1) * (b.mean - V1) <= 0) {
        const t = (V1 - a.mean) / (b.mean - a.mean)
        console.log(
          `損益分岐点: N* = ${a.n} + ${t.toFixed(3)} → 「${a.n}枚:${(100 * (1 - t)).toFixed(0)}% / ${b.n}枚:${(100 * t).toFixed(0)}%」の混合が逐次プレー（V1=${V1}）と等価`,
        )
      }
    }
    console.log(`(${Math.round((Date.now() - t0) / 1000)}s)`)
  }, 14_400_000)
})

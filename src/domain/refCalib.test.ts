// 参考ソルバー較正プローブ（手動実行）: KKハンドの代表セルを「未補正FL価値
// （参考ソルバーと同じ会計）」で評価し、参考の数値（M[KK]B[653]: FL54.8% / foul19.8%）に
// どこまで寄るかを見る。
//
//   REF_CALIB_ITERS=140 pnpm vitest run src/domain/refCalib.test.ts --testTimeout=14400000
//
import { describe, it } from 'vitest'
import { cardToString, parseCards } from './cards'
import { evaluateInitialChunk, generateInitialBoards } from './solver'
import { ULTIMATE } from './variants'

const ITERS = Number(process.env.REF_CALIB_ITERS ?? 0)

// 未補正の同枚数維持 V（E_N 補正前）: 参考ソルバーの会計と同一系。flValueAB.test.ts の VALUES_PREV。
const UNCORRECTED_JOKER: Record<number, number> = { 14: 20.4, 15: 36.8, 16: 65.8, 17: 126.1 }

// 対象セル: #6 = M[KK] B[653]（参考#1）, #25 = M[653] B[KK], #112 = T[KK] B[653], #113 = T[KK] M[6] B[53]
const TARGETS = [6, 25, 112, 113]

// 参考グリッドの正解値（過去セッションのスクリーンショット読取りから回収。EV / foul% / FL%、? = 不明）
// boardKey は generateInitialBoards の index ではなく盤面で照合する。
const REF_CELLS: { label: string; ev: number; foul: number | null; fl: number | null; top: string; middle: string; bottom: string }[] = [
  { label: '#1 M[KK] B[653]', ev: 32.9, foul: 19.8, fl: 54.8, top: '', middle: 'Kd Kh', bottom: '6d 5h 3h' },
  { label: '#2 T[KK] B[653]', ev: 30.1, foul: 34.4, fl: 65.6, top: 'Kd Kh', middle: '', bottom: '6d 5h 3h' },
  { label: '#5 M[KK6d] B[53]', ev: 29.1, foul: 20.8, fl: 55, top: '', middle: 'Kd Kh 6d', bottom: '5h 3h' },
  { label: '#6 T[KK] M[53] B[6]', ev: 28.8, foul: null, fl: null, top: 'Kd Kh', middle: '5h 3h', bottom: '6d' },
  { label: '#7 M[53] B[KK6d]', ev: 28.7, foul: 11.3, fl: 40.3, top: '', middle: '5h 3h', bottom: 'Kd Kh 6d' },
  { label: '#8 M[653] B[KK]', ev: 28.4, foul: 13.3, fl: null, top: '', middle: '6d 5h 3h', bottom: 'Kd Kh' },
]

describe('reference calibration probe (set REF_CALIB_ITERS to run)', () => {
  it.skipIf(ITERS <= 0 || process.env.REF_CALIB_CELLS !== '1')(
    'reference 6 cells with combined + uncorrected FL values',
    () => {
      const cards = parseCards('Kd Kh 6d 5h 3h')
      const boards = generateInitialBoards(cards)
      const keyOf = (top: string, middle: string, bottom: string) => {
        const norm = (s: string) =>
          s.trim() === '' ? '' : parseCards(s).map((c) => cardToString(c)).sort().join(',')
        return `${norm(top)}|${norm(middle)}|${norm(bottom)}`
      }
      const boardKey = (b: (typeof boards)[number]) =>
        `${b.top.map((c) => cardToString(c)).sort().join(',')}|${b.middle.map((c) => cardToString(c)).sort().join(',')}|${b.bottom.map((c) => cardToString(c)).sort().join(',')}`
      for (const cell of REF_CELLS) {
        const idx = boards.findIndex((b) => boardKey(b) === keyOf(cell.top, cell.middle, cell.bottom))
        if (idx < 0) {
          console.log(`[cells] ${cell.label}: board not found`)
          continue
        }
        const [m] = evaluateInitialChunk(cards, [], ULTIMATE, [idx], {
          iters: ITERS,
          seed: 0xca11b,
          jokers: true,
          futureModel: 'combined',
          flValues: UNCORRECTED_JOKER,
        })
        console.log(
          `[cells] ${cell.label} 当方 EV=${m.score.toFixed(1)} foul=${(100 * m.foulProb).toFixed(1)}% fl=${(100 * m.flProb).toFixed(1)}% ` +
            `/ 参考 EV=${cell.ev} foul=${cell.foul ?? '?'}% fl=${cell.fl ?? '?'}% ` +
            `(ΔEV=${(m.score - cell.ev).toFixed(1)})`,
        )
      }
    },
    14_400_000,
  )

  it.skipIf(ITERS <= 0 || process.env.REF_CALIB_SWEEP !== '1')(
    'lock-blend sweep on T[KK] cells (targets: #2=30.1, #6-type=28.8)',
    () => {
      const cards = parseCards('Kd Kh 6d 5h 3h')
      const boards = generateInitialBoards(cards)
      const cells = [
        { label: '#2 T[KK] B[653]', idx: 112, ev: 30.1, foul: 34.4 },
        { label: '#6型 T[KK] M[53] B[6]', idx: 118, ev: 28.8, foul: null as number | null },
      ]
      for (const max of [0.5, 0.3, 0.15, 0]) {
        for (const cell of cells) {
          const [m] = evaluateInitialChunk(cards, [], ULTIMATE, [cell.idx], {
            iters: ITERS,
            seed: 0xca11b,
            jokers: true,
            futureModel: 'combined',
            flValues: UNCORRECTED_JOKER,
            lockBlend: { max },
          })
          console.log(
            `[sweep max=${max}] ${cell.label} EV=${m.score.toFixed(1)} foul=${(100 * m.foulProb).toFixed(1)}% ` +
              `fl=${(100 * m.flProb).toFixed(1)}% (参考 EV=${cell.ev} foul=${cell.foul ?? '?'})`,
          )
        }
      }
    },
    14_400_000,
  )

  it.skipIf(ITERS <= 0 || process.env.REF_CALIB_VERIFY !== '1')(
    'calibrated lock blend: all locked T[KK] shapes + open cells',
    () => {
      const cards = parseCards('Kd Kh 6d 5h 3h')
      const boards = generateInitialBoards(cards)
      const LB = { threshold: 0.294, span: 0.16, max: 1.0 }
      const cells = [
        { label: '#2 T[KK] B[653]   (参考30.1/34.4/65.6)', idx: 112 },
        { label: '#6型 T[KK] M[53] B[6] (参考28.8/?/?)', idx: 118 },
        { label: 'T[KK] M[6] B[53]  (参考外・妥当性確認)', idx: 113 },
        { label: 'T[KK] M[65] B[3]  (参考外・妥当性確認)', idx: 116 },
        { label: '#1 M[KK] B[653]   (参考32.9/19.8/54.8)', idx: 6 },
        { label: '#8 M[653] B[KK]   (参考28.4/13.3/?)', idx: 25 },
      ]
      for (const cell of cells) {
        const [m] = evaluateInitialChunk(cards, [], ULTIMATE, [cell.idx], {
          iters: ITERS,
          seed: 0xca11b,
          jokers: true,
          futureModel: 'combined',
          flValues: UNCORRECTED_JOKER,
          lockBlend: LB,
        })
        console.log(
          `[verify] ${cell.label} EV=${m.score.toFixed(1)} foul=${(100 * m.foulProb).toFixed(1)}% fl=${(100 * m.flProb).toFixed(1)}%`,
        )
      }
    },
    14_400_000,
  )

  it.skipIf(ITERS <= 0 || process.env.REF_CALIB_GRID !== '1')(
    'full grid with combined + uncorrected FL values',
    () => {
      const cards = parseCards('Kd Kh 6d 5h 3h')
      const boards = generateInitialBoards(cards)
      const row = (cs: readonly { rank: number }[]) =>
        cs.map((c) => cardToString(c as never)).join(',') || '-'
      const t0 = Date.now()
      const all = Array.from({ length: boards.length }, (_, i) => i)
      const results = evaluateInitialChunk(cards, [], ULTIMATE, all, {
        iters: ITERS,
        seed: 0xca11b,
        jokers: true,
        futureModel: 'combined',
        flValues: UNCORRECTED_JOKER,
      })
      results.sort((a, b) => b.score - a.score)
      for (const m of results.slice(0, 10)) {
        const b = boards[m.index]
        const bd = m.flBreakdown
        console.log(
          `[grid] #${m.index} T[${row(b.top)}] M[${row(b.middle)}] B[${row(b.bottom)}] ` +
            `score=${m.score.toFixed(2)} roy=${m.expRoyalty.toFixed(2)} flEV=${m.flEV.toFixed(2)} ` +
            `foul=${(100 * m.foulProb).toFixed(1)}% fl=${(100 * m.flProb).toFixed(1)}% ` +
            `bd={14:${(100 * (bd[14] ?? 0)).toFixed(1)} 15:${(100 * (bd[15] ?? 0)).toFixed(1)} ` +
            `16:${(100 * (bd[16] ?? 0)).toFixed(1)} 17:${(100 * (bd[17] ?? 0)).toFixed(1)}}`,
        )
      }
      const rank6 = results.findIndex((m) => m.index === 6) + 1
      console.log(`[grid] M[KK]B[653] rank=${rank6}, done in ${Math.round((Date.now() - t0) / 1000)}s`)
    },
    14_400_000,
  )

  it.skipIf(ITERS <= 0)('rollout/policy-leaf with uncorrected FL values', () => {
    const cards = parseCards('Kd Kh 6d 5h 3h')
    const boards = generateInitialBoards(cards)
    const row = (cs: readonly { rank: number }[]) =>
      cs.map((c) => cardToString(c as never)).join(',') || '-'
    for (const model of ['rollout', 'policy'] as const) {
      const t0 = Date.now()
      const results = evaluateInitialChunk(cards, [], ULTIMATE, TARGETS, {
        iters: model === 'policy' ? ITERS * 4 : ITERS,
        seed: 0xca11b,
        jokers: true,
        futureModel: model,
        rolloutInner: 24,
        rolloutLeaf: 'policy',
        flValues: UNCORRECTED_JOKER,
      })
      for (const m of results) {
        const b = boards[m.index]
        const bd = m.flBreakdown
        console.log(
          `[${model}] #${m.index} T[${row(b.top)}] M[${row(b.middle)}] B[${row(b.bottom)}] ` +
            `score=${m.score.toFixed(2)} roy=${m.expRoyalty.toFixed(2)} flEV=${m.flEV.toFixed(2)} ` +
            `foul=${(100 * m.foulProb).toFixed(1)}% fl=${(100 * m.flProb).toFixed(1)}% ` +
            `bd={14:${(100 * (bd[14] ?? 0)).toFixed(1)} 15:${(100 * (bd[15] ?? 0)).toFixed(1)} ` +
            `16:${(100 * (bd[16] ?? 0)).toFixed(1)} 17:${(100 * (bd[17] ?? 0)).toFixed(1)}}`,
        )
      }
      console.log(`[${model}] done in ${Math.round((Date.now() - t0) / 1000)}s`)
    }
  }, 14_400_000)
})

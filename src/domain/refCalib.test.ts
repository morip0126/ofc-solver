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

describe('reference calibration probe (set REF_CALIB_ITERS to run)', () => {
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

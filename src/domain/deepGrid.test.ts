// KK基準ハンド（Kd Kh 6d 5h 3h・ジョーカー入り）の全初手候補を解析設定
// （rollout・iters 280・内側48）で採点するランナー。参考ソルバーのグリッドとの比較用。
// チャンク分割で並列実行する（evaluateInitialChunk は分割不変）:
//
//   DEEP_GRID_CHUNK=0:58 pnpm vitest run src/domain/deepGrid.test.ts --testTimeout=14400000
//
import { describe, it } from 'vitest'
import { cardToString, parseCards } from './cards'
import { generateInitialBoards } from './solver'
import { evaluateInitialChunk } from './solver'
import { ULTIMATE } from './variants'

const CHUNK = process.env.DEEP_GRID_CHUNK ?? ''
const ITERS = Number(process.env.DEEP_GRID_ITERS ?? 280)
const INNER = Number(process.env.DEEP_GRID_INNER ?? 48)
const SEED = 0xdeeb

describe('deep grid: KK reference hand (set DEEP_GRID_CHUNK to run)', () => {
  it.skipIf(!CHUNK)('evaluate chunk with rollout', () => {
    const [start, end] = CHUNK.split(':').map(Number)
    const cards = parseCards('Kd Kh 6d 5h 3h')
    const boards = generateInitialBoards(cards)
    const indices = Array.from({ length: end - start }, (_, i) => start + i).filter(
      (i) => i < boards.length,
    )
    const t0 = Date.now()
    const results = evaluateInitialChunk(cards, [], ULTIMATE, indices, {
      iters: ITERS,
      seed: SEED,
      jokers: true,
      futureModel: 'rollout',
      rolloutInner: INNER,
    })
    for (const m of results) {
      const b = boards[m.index]
      const row = (cs: readonly { id: number }[]) =>
        cs.map((c) => cardToString(c as never)).join(',') || '-'
      const bd = m.flBreakdown
      console.log(
        `#${m.index} T[${row(b.top)}] M[${row(b.middle)}] B[${row(b.bottom)}] ` +
          `score=${m.score.toFixed(2)} roy=${m.expRoyalty.toFixed(2)} flEV=${m.flEV.toFixed(2)} ` +
          `foul=${(100 * m.foulProb).toFixed(1)}% fl=${(100 * m.flProb).toFixed(1)}% ` +
          `bd={14:${(100 * (bd[14] ?? 0)).toFixed(1)} 15:${(100 * (bd[15] ?? 0)).toFixed(1)} ` +
          `16:${(100 * (bd[16] ?? 0)).toFixed(1)} 17:${(100 * (bd[17] ?? 0)).toFixed(1)}}`,
      )
    }
    console.log(`chunk ${CHUNK}: ${results.length} candidates in ${Math.round((Date.now() - t0) / 1000)}s`)
  }, 14_400_000)
})

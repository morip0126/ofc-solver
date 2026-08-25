// 粗カットの安全マージン実証（手動実行）: streets 軽量採点で全232候補を測り、
// フル忠実度（rollout/policy末端）の正解上位と突き合わせて「首位から何点差までを
// 残せば正解上位を落とさないか」を求める。
//   CULL_CHECK=1 pnpm vitest run src/domain/cullCheck.test.ts --testTimeout=600000
import { describe, it } from 'vitest'
import { parseCards } from './cards'
import { evaluateInitialChunk, generateInitialBoards } from './solver'
import { ULTIMATE } from './variants'

// フル忠実度（policy末端・140本）の正解上位10（deepGridPolicy 計測より）
const TRUE_TOP10 = [112, 6, 13, 113, 25, 118, 14, 106, 34, 15]

describe('coarse cull margin check (set CULL_CHECK=1 to run)', () => {
  it.skipIf(process.env.CULL_CHECK !== '1')('coarse scores vs true top', () => {
    const cards = parseCards('Kd Kh 6d 5h 3h')
    const boards = generateInitialBoards(cards)
    const all = Array.from({ length: boards.length }, (_, i) => i)
    for (const model of ['streets', 'policy', 'combined'] as const) {
    const t0 = Date.now()
    const res = evaluateInitialChunk(cards, [], ULTIMATE, all, {
      iters: 64,
      seed: 0xc0de,
      jokers: true,
      futureModel: model,
    })
    const dt = (Date.now() - t0) / 1000
    const byIndex = new Map(res.map((m) => [m.index, m.score]))
    const best = Math.max(...res.map((m) => m.score))
    // 正解上位それぞれの「粗採点での首位との差」
    for (const idx of TRUE_TOP10) {
      console.log(`[${model}] true#${TRUE_TOP10.indexOf(idx) + 1} idx=${idx} coarseGap=${(best - (byIndex.get(idx) ?? -999)).toFixed(1)}`)
    }
    for (const margin of [6, 8, 10, 12, 15]) {
      const survivors = res.filter((m) => m.score >= best - margin).length
      const lostTop5 = TRUE_TOP10.slice(0, 5).filter((idx) => (byIndex.get(idx) ?? -999) < best - margin)
      console.log(`[${model}] margin=${margin}: survivors=${survivors}/232 lostTop5=[${lostTop5.join(',')}]`)
    }
    console.log(`[${model}] coarse eval time=${dt.toFixed(1)}s (single-thread)`)
    }
  }, 600_000)
})

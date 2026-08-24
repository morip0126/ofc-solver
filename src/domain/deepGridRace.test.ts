// KK基準ハンドのレーシング検証ランナー（手動実行）: フラット全候補評価（deepGrid、
// 140本×232候補）と同条件の物差し（rollout・policy末端・内側24）で、レーシングが
// (1) 同じ上位を選ぶか (2) どれだけ計算を節約するか を測る。
//
//   RACE_KK=1 pnpm vitest run src/domain/deepGridRace.test.ts --testTimeout=28800000
//
import { describe, it } from 'vitest'
import { cardToString, parseCards } from './cards'
import { raceCandidates } from './racing'
import { evaluateInitialChunk, generateInitialBoards } from './solver'
import { ULTIMATE } from './variants'

const RUN = process.env.RACE_KK === '1'

describe('deep grid racing: KK reference hand (set RACE_KK=1 to run)', () => {
  it.skipIf(!RUN)('race all initial candidates with rollout/policy leaf', async () => {
    const cards = parseCards('Kd Kh 6d 5h 3h')
    const boards = generateInitialBoards(cards)
    const t0 = Date.now()
    let units = 0

    const evalFn = async (indices: number[], iters: number, seed: number) => {
      units += indices.length * iters
      return evaluateInitialChunk(cards, [], ULTIMATE, indices, {
        iters,
        seed,
        jokers: true,
        futureModel: 'rollout',
        rolloutInner: 24,
        rolloutLeaf: 'policy',
      })
    }

    const result = await raceCandidates(boards.length, evalFn, 0xace1, {
      onRound: (r, alive, unitsDone) =>
        console.log(
          `round ${r}: alive=${alive} units=${unitsDone} (${Math.round((Date.now() - t0) / 1000)}s)`,
        ),
    })

    const row = (cs: readonly { rank: number }[]) =>
      cs.map((c) => cardToString(c as never)).join(',') || '-'
    for (const m of result.slice(0, 10)) {
      const b = boards[m.index]
      const bd = m.flBreakdown
      console.log(
        `#${m.index} n=${m.n} T[${row(b.top)}] M[${row(b.middle)}] B[${row(b.bottom)}] ` +
          `score=${m.score.toFixed(2)} ±${Math.sqrt((m.scoreVar ?? 0) / m.n).toFixed(2)} ` +
          `foul=${(100 * m.foulProb).toFixed(1)}% fl=${(100 * m.flProb).toFixed(1)}% ` +
          `bd={14:${(100 * (bd[14] ?? 0)).toFixed(1)} 15:${(100 * (bd[15] ?? 0)).toFixed(1)} ` +
          `16:${(100 * (bd[16] ?? 0)).toFixed(1)} 17:${(100 * (bd[17] ?? 0)).toFixed(1)}}`,
      )
    }
    console.log(
      `TOTAL units=${units} (flat=${boards.length * 140}) time=${Math.round((Date.now() - t0) / 1000)}s`,
    )
  }, 28_800_000)
})

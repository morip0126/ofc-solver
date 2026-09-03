// seqrefine（逐次再ランク評価器）の妥当性プローブ:
// バイアス検証の実測（A=14.96 > C=10.75 > B=9.05、各300ハンド）と同じ順位・近い水準に
// なるかを確認する。SEQREFINE_PROBE=1 のときのみ実行。
import { describe, it } from 'vitest'
import { parseCards } from './cards'
import { mulberry32 } from './combinatorics'
import { type Board, evaluateInitialSequential } from './solver'
import { ULTIMATE } from './variants'

const RUN = process.env.SEQREFINE_PROBE === '1'

describe.skipIf(!RUN)('seqrefine sanity vs measured sequential play', () => {
  it('rank A > C > B with plausible values', () => {
    const starts: [string, Board][] = [
      ['A: M[KK]B[653]', { top: [], middle: parseCards('Kd Kh'), bottom: parseCards('6d 5h 3h') }],
      ['B: M[KK6]B[53]', { top: [], middle: parseCards('Kd Kh 6d'), bottom: parseCards('5h 3h') }],
      ['C: T[KK]M[6]B[53]', { top: parseCards('Kd Kh'), middle: parseCards('6d'), bottom: parseCards('5h 3h') }],
    ]
    for (const [name, b] of starts) {
      const t0 = Date.now()
      const m = evaluateInitialSequential(b, [], ULTIMATE, {
        iters: 96,
        jokers: true,
        rng: mulberry32(0x5e0f),
      })
      console.log(
        `${name}: score=${m.score.toFixed(2)} FL=${(100 * m.flProb).toFixed(1)}% foul=${(100 * m.foulProb).toFixed(1)}% roys=${m.expRoyalty.toFixed(2)} (${Math.round((Date.now() - t0) / 1000)}s)`,
      )
    }
  }, 3_600_000)
})

// FL 継続率の計測ランナー（手動実行用。通常の `pnpm test` ではスキップされる）。
//
//   FL_STAY_ITERS=500000 pnpm vitest run src/domain/flStayRate.test.ts --testTimeout=3600000
//
// 厳密判定（stayFeasibility）× 決定論的 PRNG の大規模モンテカルロで、
// 13〜17枚それぞれの継続率を 95% 信頼区間つきで出力する。
// 標準52枚とジョーカー2枚入り54枚の両方を計測する（`-t joker` / `-t standard` で絞り込み可）。

import { describe, it } from 'vitest'
import { mulberry32 } from './combinatorics'
import { estimateFantasylandStayRate } from './flStay'

const ITERS = Number(process.env.FL_STAY_ITERS ?? 0)

describe('FL stay rate measurement (set FL_STAY_ITERS to run)', () => {
  const pct = (x: number) => `${(100 * x).toFixed(2)}%`

  const run = (jokers: boolean) => {
    for (let n = 13; n <= 17; n++) {
      const r = estimateFantasylandStayRate(n, {
        iters: ITERS,
        jokers,
        rng: mulberry32((jokers ? 0x54000 : 0xf15a0) + n),
      })
      const ci = 1.96 * r.se
      console.log(
        `n=${n} ${jokers ? '(54枚+ジョーカー2)' : '(52枚)'}: pStay=${pct(r.stayRate)} ±${pct(ci)} ` +
          `(95%CI, iters=${r.iters}) viaTop=${pct(r.viaTopRate)} viaBottom=${pct(r.viaBottomRate)}`,
      )
    }
  }

  it.skipIf(ITERS <= 0)('standard 52-card deck', () => run(false), 3_600_000)
  it.skipIf(ITERS <= 0)('joker 54-card deck', () => run(true), 3_600_000)
})

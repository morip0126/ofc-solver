import { describe, expect, it } from 'vitest'
import { mulberry32 } from './combinatorics'
import { raceCandidates } from './racing'
import type { CandidateMetric } from './solver'

describe('raceCandidates', () => {
  it('真の上位を残し、明確に劣る候補を早期脱落させる', async () => {
    // 合成問題: 候補iの真のスコア = 20 - i（候補0が最強）。分散は一定。
    const N = 50
    const VAR = 25
    let evaluatedUnits = 0
    const evalFn = async (indices: number[], iters: number, seed: number): Promise<CandidateMetric[]> => {
      evaluatedUnits += indices.length * iters
      return indices.map((index) => {
        const rng = mulberry32(seed * 31 + index * 7 + 1)
        // iters 本の平均に相当するノイズ（SE = sqrt(VAR/iters)）
        const noise = (rng() + rng() + rng() - 1.5) * Math.sqrt(VAR / iters)
        return {
          index,
          score: 20 - index + noise,
          scoreVar: VAR,
          expRoyalty: 0,
          flProb: 0,
          flEV: 0,
          foulProb: 0,
          flBreakdown: {},
        }
      })
    }

    const result = await raceCandidates(N, evalFn, 42, {
      rounds: [{ iters: 10 }, { iters: 20 }, { iters: 40 }],
      dropSigma: 3,
      minKeep: 5,
    })

    // 全候補が返る（脱落者も部分統計つきで後方に並ぶ）
    expect(result).toHaveLength(N)
    // スコア降順
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score)
    }
    // 真の1位（index 0）が最終上位3以内に残る（ノイズ考慮のゆるい判定）
    expect(result.slice(0, 3).map((r) => r.index)).toContain(0)
    // 明確に劣る候補（真のスコア -10 以下 = index 30+）はフル評価されていない
    const worst = result.find((r) => r.index === N - 1)!
    expect(worst.n).toBeLessThan(70)
    // フラット評価（50×70）より計算量が節約されている
    expect(evaluatedUnits).toBeLessThan(50 * 70)
  })

  it('minKeep を下回らない', async () => {
    const evalFn = async (indices: number[], iters: number, seed: number): Promise<CandidateMetric[]> =>
      indices.map((index) => ({
        index,
        // 候補0だけ圧倒的、他は大差の劣位 → 積極的に脱落するケース
        score: index === 0 ? 100 : -50 - index + mulberry32(seed + index)(),
        scoreVar: 1,
        expRoyalty: 0,
        flProb: 0,
        flEV: 0,
        foulProb: 0,
        flBreakdown: {},
      }))
    const result = await raceCandidates(20, evalFn, 7, {
      rounds: [{ iters: 10 }, { iters: 10 }, { iters: 10 }],
      minKeep: 6,
    })
    // 最終ラウンドまで6候補は評価され続ける（n = 30）
    const fullyEvaluated = result.filter((r) => r.n === 30)
    expect(fullyEvaluated.length).toBeGreaterThanOrEqual(6)
  })
})

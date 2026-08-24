// レーシング（逐次淘汰）: 全候補を同じ物差し（呼び出し側の evalFn）で少しずつ評価し、
// 統計的に首位へ届く見込みのない候補をラウンドごとに脱落させ、計算を生き残りに集中する。
//
// 以前の「粗選別」（別の軽量モデルで足切り）と違い、物差しが同一なのでモデル由来の偏りは
// 入らない。脱落判定は保守的（差が dropSigma×SE を超えたときだけ）にして、真の上位を
// 誤って落とす確率を抑える。共通乱数（同ラウンド内で全候補に同じ seed）前提。
// 設計はユーザー提案（2026-08、「著しく悪い候補を早期に省く」）。

import type { CandidateMetric } from './solver'

export interface RaceRoundSpec {
  /** このラウンドで生存候補1つあたりに追加するプレイアウト本数。 */
  iters: number
}

export interface RaceOptions {
  /** ラウンド構成。既定 [12, 24, 48, 120]（最終生存者は計204本）。 */
  rounds?: readonly RaceRoundSpec[]
  /** 脱落しきい値: 首位との差が dropSigma × SE(差) を超えたら脱落。既定 3。 */
  dropSigma?: number
  /** これ未満には減らさない生存数。既定 8。 */
  minKeep?: number
  /** ラウンド完了ごとの通知（進捗表示用）: (完了ラウンド数, 生存数, 累計評価ユニット)。 */
  onRound?: (round: number, alive: number, unitsDone: number) => void
}

export const DEFAULT_RACE_ROUNDS: readonly RaceRoundSpec[] = [
  { iters: 12 },
  { iters: 24 },
  { iters: 48 },
  { iters: 120 },
]

interface Merged {
  index: number
  n: number
  expRoyalty: number
  flProb: number
  flEV: number
  foulProb: number
  flBreakdown: Record<number, number>
  score: number
  scoreVar: number
}

function mergeInto(acc: Merged, m: CandidateMetric, iters: number): void {
  const n0 = acc.n
  const n1 = iters
  const N = n0 + n1
  const w0 = n0 / N
  const w1 = n1 / N
  // 分散の合成は E[c^2] 経由（sum2/N − mean^2）
  const e2a = acc.scoreVar + acc.score * acc.score
  const e2b = (m.scoreVar ?? 0) + m.score * m.score
  acc.expRoyalty = w0 * acc.expRoyalty + w1 * m.expRoyalty
  acc.flProb = w0 * acc.flProb + w1 * m.flProb
  acc.flEV = w0 * acc.flEV + w1 * m.flEV
  acc.foulProb = w0 * acc.foulProb + w1 * m.foulProb
  for (const k of new Set([...Object.keys(acc.flBreakdown), ...Object.keys(m.flBreakdown)])) {
    const key = Number(k)
    acc.flBreakdown[key] = w0 * (acc.flBreakdown[key] ?? 0) + w1 * (m.flBreakdown[key] ?? 0)
  }
  acc.score = w0 * acc.score + w1 * m.score
  acc.scoreVar = Math.max(0, w0 * e2a + w1 * e2b - acc.score * acc.score)
  acc.n = N
}

/**
 * count 個の候補（index 0..count-1）をレーシングで評価し、全候補の統合メトリクスを
 * score 降順で返す（脱落した候補は脱落時点までの統計のまま後方に並ぶ）。
 * evalFn は「同一 seed なら同一の未来セット」で indices を評価すること（共通乱数）。
 */
export async function raceCandidates(
  count: number,
  evalFn: (indices: number[], iters: number, seed: number) => Promise<CandidateMetric[]>,
  seed: number,
  options: RaceOptions = {},
): Promise<(CandidateMetric & { n: number })[]> {
  const rounds = options.rounds ?? DEFAULT_RACE_ROUNDS
  const dropSigma = options.dropSigma ?? 3
  const minKeep = options.minKeep ?? 8

  const merged = new Map<number, Merged>()
  let alive = Array.from({ length: count }, (_, i) => i)
  let unitsDone = 0

  for (let r = 0; r < rounds.length; r++) {
    const iters = rounds[r].iters
    const results = await evalFn(alive, iters, seed + r * 7919)
    for (const m of results) {
      const acc = merged.get(m.index)
      if (!acc) {
        merged.set(m.index, {
          index: m.index,
          n: iters,
          expRoyalty: m.expRoyalty,
          flProb: m.flProb,
          flEV: m.flEV,
          foulProb: m.foulProb,
          flBreakdown: { ...m.flBreakdown },
          score: m.score,
          scoreVar: m.scoreVar ?? 0,
        })
      } else {
        mergeInto(acc, m, iters)
      }
    }
    unitsDone += alive.length * iters

    // 脱落判定（最終ラウンド後は不要だが、順位付けのため統計は更新済み）
    if (r < rounds.length - 1) {
      const stats = alive.map((i) => merged.get(i)!)
      let best = stats[0]
      for (const s of stats) if (s.score > best.score) best = s
      const seBest2 = best.scoreVar / best.n
      const survivors = stats
        .filter((s) => {
          if (s === best) return true
          const se = Math.sqrt(s.scoreVar / s.n + seBest2)
          return s.score >= best.score - dropSigma * se
        })
        .map((s) => s.index)
      if (survivors.length >= minKeep) {
        alive = survivors
      } else {
        // minKeep を割る場合は score 上位 minKeep を残す
        alive = stats
          .slice()
          .sort((a, b) => b.score - a.score)
          .slice(0, minKeep)
          .map((s) => s.index)
      }
    }
    options.onRound?.(r + 1, alive.length, unitsDone)
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .map((s) => ({
      index: s.index,
      n: s.n,
      expRoyalty: s.expRoyalty,
      flProb: s.flProb,
      flEV: s.flEV,
      foulProb: s.foulProb,
      flBreakdown: s.flBreakdown,
      score: s.score,
      scoreVar: s.scoreVar,
    }))
}

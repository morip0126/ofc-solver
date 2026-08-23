// 2段読みプローブ（壁打ち検証用・手動実行）: M[KdKh] B[6d5h3h] の1候補だけを、
// 想像内の 1st ストリート判断を「1stの全手 × 仮想2nd引き × 2ndの全手 → policy見積もり」の
// 2段読みにしたロールアウトで採点する。1段読み（deepGrid の policy 末端）との比較用。
//
//   TWO_PLY_ITERS=35 TWO_PLY_SEED=1 pnpm vitest run src/domain/twoPlyProbe.test.ts --testTimeout=14400000
//
// 4プロセス（seed 1..4 × 35本）を平均して 140 本相当にする。
import { describe, it } from 'vitest'
import { type Card, parseCards, remainingDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { type Arrangement, evaluateArrangement, fantasylandCards, royaltiesTotal } from './score'
import {
  type Board,
  DEFAULT_FL_VALUES_JOKER,
  DEFAULT_FOUL_WEIGHT,
  evaluateBoard,
  generateStreetBoards,
} from './solver'
import { ULTIMATE } from './variants'

const ITERS = Number(process.env.TWO_PLY_ITERS ?? 0)
const SEED = Number(process.env.TWO_PLY_SEED ?? 1)
const DRAW_SAMPLES = 6 // 仮想2nd引きのサンプル数
const INNER2 = 16 // 2段読み末端の policy 見積もり反復数
const INNER1 = 24 // 2nd〜4th ストリート判断（1段読み）の反復数（deepGrid と同じ）

describe('two-ply probe on M[KK] B[653] (set TWO_PLY_ITERS to run)', () => {
  it.skipIf(ITERS <= 0)('rollout with 2-ply first street', () => {
    const board: Board = {
      top: [],
      middle: parseCards('Kd Kh'),
      bottom: parseCards('6d 5h 3h'),
    }
    const placed = [...board.top, ...board.middle, ...board.bottom]
    const rng = mulberry32(0x2b17 + SEED * 0x9e37)
    const deck = remainingDeck(placed, true)

    let roySum = 0
    let fouls = 0
    let flCount = 0
    let flValueSum = 0
    const flCounts: Record<number, number> = { 14: 0, 15: 0, 16: 0, 17: 0 }
    const t0 = Date.now()

    for (let it = 0; it < ITERS; it++) {
      shuffle(deck, rng)
      const cur: Board = { top: [...board.top], middle: [...board.middle], bottom: [...board.bottom] }
      const curDead: Card[] = []
      let failed = false

      for (let s = 0; s < 4; s++) {
        const drawn = [deck[s * 3], deck[s * 3 + 1], deck[s * 3 + 2]]
        const cands = generateStreetBoards(cur, drawn)
        if (cands.length === 0) {
          failed = true
          break
        }
        let bestIdx = -1
        let bestScore = -Infinity

        if (s === 0) {
          // 2段読み: 各手Xについて、仮想の2nd引きをサンプルし、2ndの全手を policy 見積もりで
          // 最良選択した平均値で採点する。仮想引き・末端シードは全手で共通（共通乱数法）。
          const unseen = deck.slice(3) // 1st の3枚以外は未知
          const drawSeed = (rng() * 0x100000000) >>> 0
          const draws: Card[][] = []
          {
            const pool = [...unseen]
            const drawRng = mulberry32(drawSeed)
            for (let d = 0; d < DRAW_SAMPLES; d++) {
              shuffle(pool, drawRng)
              draws.push([pool[0], pool[1], pool[2]])
            }
          }
          const leafSeed = (rng() * 0x100000000) >>> 0
          if (process.env.TWO_PLY_DEBUG && it === 0) {
            const td = Date.now()
            const c2 = generateStreetBoards(cands[0].board, draws[0])
            const te = Date.now()
            const m = evaluateBoard(c2[0].board, [cands[0].discarded, c2[0].discarded], ULTIMATE, {
              iters: INNER2,
              rng: mulberry32(leafSeed),
              jokers: true,
              futureModel: 'policy',
            })
            console.log(
              `DEBUG cands1=${cands.length} cands2=${c2.length} gen=${te - td}ms ` +
                `eval16=${Date.now() - te}ms score=${m.score.toFixed(2)}`,
            )
          }
          let evalCalls = 0
          const tStreet1 = Date.now()
          for (let ci = 0; ci < cands.length; ci++) {
            const afterDead = [...curDead, cands[ci].discarded]
            let sum = 0
            for (let d = 0; d < DRAW_SAMPLES; d++) {
              // 仮想引きは unseen（1st の3枚以外）から取るので捨て札とは構造上衝突しない
              const dr = draws[d]
              const cands2 = generateStreetBoards(cands[ci].board, dr)
              let best2 = -Infinity
              for (let cj = 0; cj < cands2.length; cj++) {
                evalCalls++
                const m = evaluateBoard(cands2[cj].board, [...afterDead, cands2[cj].discarded], ULTIMATE, {
                  iters: INNER2,
                  rng: mulberry32(leafSeed + d),
                  jokers: true,
                  futureModel: 'policy',
                })
                if (m.score > best2) best2 = m.score
              }
              sum += best2
            }
            const v = sum / DRAW_SAMPLES
            if (v > bestScore) {
              bestScore = v
              bestIdx = ci
            }
          }
          if (process.env.TWO_PLY_DEBUG && it < 2) {
            console.log(`DEBUG street1: evalCalls=${evalCalls} in ${Date.now() - tStreet1}ms`)
          }
        } else {
          // 2nd〜4th: 1段読み（deepGrid の rollout と同じ）
          const stSeed = (rng() * 0x100000000) >>> 0
          for (let ci = 0; ci < cands.length; ci++) {
            const m = evaluateBoard(cands[ci].board, [...curDead, cands[ci].discarded], ULTIMATE, {
              iters: INNER1,
              rng: mulberry32(stSeed),
              jokers: true,
              futureModel: 'policy',
            })
            if (m.score > bestScore) {
              bestScore = m.score
              bestIdx = ci
            }
          }
        }

        const chosen = cands[bestIdx]
        cur.top = chosen.board.top
        cur.middle = chosen.board.middle
        cur.bottom = chosen.board.bottom
        curDead.push(chosen.discarded)
      }

      if (failed) {
        fouls++
        continue
      }
      const ev = evaluateArrangement(cur as Arrangement)
      if (ev.fouled) fouls++
      else {
        roySum += royaltiesTotal(ev)
        const fc = fantasylandCards(ev, ULTIMATE)
        if (fc > 0) {
          flCount++
          flValueSum += DEFAULT_FL_VALUES_JOKER[fc] ?? 0
          flCounts[fc] = (flCounts[fc] ?? 0) + 1
        }
      }
      if ((it + 1) % 5 === 0) console.log(`... ${it + 1}/${ITERS} (${Math.round((Date.now() - t0) / 1000)}s)`)
    }

    const n = ITERS
    const roy = roySum / n
    const flEV = flValueSum / n
    const foul = fouls / n
    const score = roy + flEV - DEFAULT_FOUL_WEIGHT * foul
    console.log(
      `RESULT seed=${SEED} n=${n} score=${score.toFixed(2)} roy=${roy.toFixed(2)} flEV=${flEV.toFixed(2)} ` +
        `foul=${(100 * foul).toFixed(1)}% fl=${((100 * flCount) / n).toFixed(1)}% ` +
        `bd={14:${(100 * flCounts[14]) / n} 15:${(100 * flCounts[15]) / n} 16:${(100 * flCounts[16]) / n} 17:${(100 * flCounts[17]) / n}} ` +
        `(${Math.round((Date.now() - t0) / 1000)}s)`,
    )
  }, 14_400_000)
})

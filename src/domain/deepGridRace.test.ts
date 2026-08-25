// KK基準ハンドのレーシング検証ランナー（手動実行）: フラット全候補評価（deepGrid、
// 140本×232候補）と同条件の物差し（rollout・policy末端・内側24）で、レーシングが
// (1) 同じ上位を選ぶか (2) どれだけ計算を節約するか を測る。
//
//   RACE_KK=1 pnpm vitest run src/domain/deepGridRace.test.ts --testTimeout=28800000
//
// 進捗はラウンド単位で RACE_KK_DIR にキャッシュされ、中断後の再実行はキャッシュを
// 瞬時に再生してから続きを計算する（コンテナ再起動対策）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { cardToString, parseCards } from './cards'
import { raceCandidates } from './racing'
import { type CandidateMetric, evaluateInitialChunk, generateInitialBoards } from './solver'
import { ULTIMATE } from './variants'

const RUN = process.env.RACE_KK === '1'
const CACHE_DIR = process.env.RACE_KK_DIR ?? '/tmp/raceKK-cache'
// 縮小実行用: ラウンド本数（カンマ区切り）と rollout 内側反復数。既定はフル忠実度。
const ROUNDS = (process.env.RACE_KK_ROUNDS ?? '12,24,48,120').split(',').map(Number)
const INNER = Number(process.env.RACE_KK_INNER ?? 24)

describe('deep grid racing: KK reference hand (set RACE_KK=1 to run)', () => {
  it.skipIf(!RUN)('race all initial candidates with rollout/policy leaf', async () => {
    const cards = parseCards('Kd Kh 6d 5h 3h')
    const boards = generateInitialBoards(cards)
    const t0 = Date.now()
    let units = 0
    mkdirSync(CACHE_DIR, { recursive: true })
    const logFile = join(CACHE_DIR, 'progress.log')
    const log = (line: string): void => {
      console.log(line)
      appendFileSync(logFile, line + '\n')
    }

    const evalFn = async (indices: number[], iters: number, seed: number) => {
      const cacheFile = join(CACHE_DIR, `round-${seed}-${iters}.json`)
      if (existsSync(cacheFile)) {
        const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
          indices: number[]
          results: CandidateMetric[]
        }
        if (cached.indices.join() === indices.join()) {
          log(`round seed=${seed}: cache hit (${indices.length} candidates)`)
          return cached.results
        }
      }
      units += indices.length * iters
      const results = evaluateInitialChunk(cards, [], ULTIMATE, indices, {
        iters,
        seed,
        jokers: true,
        futureModel: 'rollout',
        rolloutInner: INNER,
        rolloutLeaf: 'policy',
      })
      writeFileSync(cacheFile, JSON.stringify({ indices, results }))
      return results
    }

    const result = await raceCandidates(boards.length, evalFn, 0xace1, {
      rounds: ROUNDS.map((iters) => ({ iters })),
      onRound: (r, alive, unitsDone) =>
        log(
          `round ${r}: alive=${alive} units=${unitsDone} (${Math.round((Date.now() - t0) / 1000)}s)`,
        ),
    })

    const row = (cs: readonly { rank: number }[]) =>
      cs.map((c) => cardToString(c as never)).join(',') || '-'
    for (const m of result.slice(0, 10)) {
      const b = boards[m.index]
      const bd = m.flBreakdown
      log(
        `#${m.index} n=${m.n} T[${row(b.top)}] M[${row(b.middle)}] B[${row(b.bottom)}] ` +
          `score=${m.score.toFixed(2)} ±${Math.sqrt((m.scoreVar ?? 0) / m.n).toFixed(2)} ` +
          `foul=${(100 * m.foulProb).toFixed(1)}% fl=${(100 * m.flProb).toFixed(1)}% ` +
          `bd={14:${(100 * (bd[14] ?? 0)).toFixed(1)} 15:${(100 * (bd[15] ?? 0)).toFixed(1)} ` +
          `16:${(100 * (bd[16] ?? 0)).toFixed(1)} 17:${(100 * (bd[17] ?? 0)).toFixed(1)}}`,
      )
    }
    log(
      `TOTAL units=${units} (flat=${boards.length * 140}) time=${Math.round((Date.now() - t0) / 1000)}s`,
    )
  }, 28_800_000)
})

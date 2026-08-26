// M[KdKh] B[6d5h3h] スタートで残り12枚を一括で見てから、FL価値込みで最適配置した場合の
// 統計（後知恵の到達上限）。ジョーカーは現行ルール（ファウルしない置換の中で最強）。
//
//   HINDSIGHT_CELL_HANDS=2000 pnpm vitest run src/domain/hindsightCell.test.ts --testTimeout=3600000
//
import { describe, it } from 'vitest'
import { parseCards, remainingDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { fantasylandCards } from './score'
import {
  type Board,
  DEFAULT_FL_VALUES_JOKER,
  UNCORRECTED_FL_VALUES_JOKER,
  bestCompletionChoose,
} from './solver'
import { ULTIMATE } from './variants'

const HANDS = Number(process.env.HINDSIGHT_CELL_HANDS ?? 0)

describe('hindsight upper bound for M[KK] B[653] (set HINDSIGHT_CELL_HANDS to run)', () => {
  it.skipIf(HANDS <= 0)('deal 12 at once, arrange optimally with FL values', () => {
    const board: Board = {
      top: [],
      middle: parseCards('Kd Kh'),
      bottom: parseCards('6d 5h 3h'),
    }
    const placed = [...board.middle, ...board.bottom]
    const rng = mulberry32(0xce11)
    const deck = remainingDeck(placed, true)

    let fouls = 0
    let roySum = 0
    const entries: Record<number, number> = { 14: 0, 15: 0, 16: 0, 17: 0 }
    const t0 = Date.now()
    for (let h = 0; h < HANDS; h++) {
      shuffle(deck, rng)
      const r = bestCompletionChoose(board, deck.slice(0, 12), ULTIMATE, DEFAULT_FL_VALUES_JOKER)
      if (!r || r.evaluated.fouled) {
        fouls++
        continue
      }
      roySum += r.royalties
      const fl = fantasylandCards(r.evaluated, ULTIMATE)
      if (fl > 0) entries[fl]++
      if ((h + 1) % 500 === 0) {
        console.log(`... ${h + 1}/${HANDS} (${Math.round((Date.now() - t0) / 1000)}s)`)
      }
    }

    const pct = (x: number) => ((100 * x) / HANDS).toFixed(1)
    const totalEntries = entries[14] + entries[15] + entries[16] + entries[17]
    const flSum = (t: Readonly<Record<number, number>>) =>
      [14, 15, 16, 17].reduce((a, n) => a + entries[n] * (t[n] ?? 0), 0)
    console.log(
      `通算成績 ハンド数 ${HANDS} / FL突入率 ${pct(totalEntries)}% / ファウル率 ${pct(fouls)}%`,
    )
    console.log(
      `素点平均 ${(roySum / HANDS).toFixed(2)} / ` +
        `FL価値込み平均 ${((roySum + flSum(DEFAULT_FL_VALUES_JOKER)) / HANDS).toFixed(2)} / ` +
        `二重計上FL価値込み平均 ${((roySum + flSum(UNCORRECTED_FL_VALUES_JOKER)) / HANDS).toFixed(2)}`,
    )
    console.log(
      `FL内訳: QQ:${pct(entries[14])}% KK:${pct(entries[15])}% AA:${pct(entries[16])}% tri:${pct(entries[17])}%`,
    )
    console.log(`(${Math.round((Date.now() - t0) / 1000)}s)`)
  }, 3_600_000)
})

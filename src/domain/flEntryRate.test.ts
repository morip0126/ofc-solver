// FL 突入率の計測ランナー（手動実行用。通常の `pnpm test` ではスキップ）。
//
//   FL_ENTRY_HANDS=1000 pnpm vitest run src/domain/flEntryRate.test.ts --testTimeout=7200000
//
// 通常ハンドを実戦アシスタントの推奨手 #1（EV最大化ヒューリスティック）でプレイし、
// 完成時に FL 突入（top QQ+、非ファウル）となった割合を実測する。
// 突入率は「突入だけを最大化する打ち方」ではなく推奨プレイの値である点に注意
// （FL価値はスコアに織り込み済みなので、EV上見合うときだけ QQ+ を狙う）。
// 枚数内訳（QQ=14 / KK=15 / AA=16 / トリップス=17）も出力する。

import { describe, it } from 'vitest'
import { type Card, makeDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { type Arrangement, evaluateArrangement, fantasylandCards } from './score'
import { type Board, suggestInitial5, suggestStreet } from './solver'
import { ULTIMATE } from './variants'

const HANDS = Number(process.env.FL_ENTRY_HANDS ?? 0)

function measureEntry(jokers: boolean, hands: number, seed: number): void {
  const label = jokers ? '54枚+ジョーカー2' : '52枚'
  const rng = mulberry32(seed)
  const deck = makeDeck(jokers)
  let entries = 0
  let fouls = 0
  const bySize: Record<number, number> = { 14: 0, 15: 0, 16: 0, 17: 0 }
  const t0 = Date.now()
  for (let h = 0; h < hands; h++) {
    shuffle(deck, rng)
    let board: Board = suggestInitial5(deck.slice(0, 5), [], ULTIMATE, {
      iters: 64,
      refineTopK: 8,
      jokers,
      rng,
    })[0].board
    const discards: Card[] = []
    for (let s = 0; s < 4; s++) {
      const drawn = deck.slice(5 + 3 * s, 8 + 3 * s)
      const best = suggestStreet(board, drawn, discards, ULTIMATE, { iters: 96, jokers, rng })[0]
      board = best.board
      if (best.discarded) discards.push(best.discarded)
    }
    const final = evaluateArrangement(board as Arrangement)
    if (final.fouled) {
      fouls++
      continue
    }
    const fl = fantasylandCards(final, ULTIMATE)
    if (fl > 0) {
      entries++
      bySize[fl]++
    }
  }
  const p = entries / hands
  const se = Math.sqrt((p * (1 - p)) / hands)
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`
  console.log(
    `[${label}] FL突入率=${pct(p)} ±${pct(1.96 * se)} (95%CI, hands=${hands}) foul=${pct(fouls / hands)} ` +
      `内訳 QQ=${pct(bySize[14] / hands)} KK=${pct(bySize[15] / hands)} AA=${pct(bySize[16] / hands)} ` +
      `Trips=${pct(bySize[17] / hands)} (${Math.round((Date.now() - t0) / 1000)}s)`,
  )
}

describe('FL entry rate measurement (set FL_ENTRY_HANDS to run)', () => {
  it.skipIf(HANDS <= 0)('52-card deck', () => measureEntry(false, HANDS, 0x52e0), 7_200_000)
  it.skipIf(HANDS <= 0)('54-card joker deck', () => measureEntry(true, HANDS, 0x54e0), 7_200_000)
})

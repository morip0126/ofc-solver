// セル特化の逐次自己プレー計測: 初手を M[KdKh] B[6d5h3h] に固定し、各ストリートは
// 指定の futureModel で推奨手#1を採用してプレーする（新ジョーカールール・アルティメット・54枚）。
// 参考ソルバーの同セル（FL 54.8% / foul 19.8% / EV 32.9）との比較用。
//
//   CELL_PLAY_HANDS=400 CELL_PLAY_MODEL=policy pnpm vitest run src/domain/cellPlay.test.ts --testTimeout=14400000
//
// CELL_PLAY_MODEL: policy | streets | combined。CELL_PLAY_SEED でチャンク分割可。
import { describe, it } from 'vitest'
import { type Card, parseCards, remainingDeck } from './cards'
import { mulberry32, shuffle } from './combinatorics'
import { type Arrangement, evaluateArrangement, fantasylandCards, royaltiesTotal } from './score'
import {
  type Board,
  DEFAULT_FL_VALUES_JOKER,
  UNCORRECTED_FL_VALUES_JOKER,
  bestCompletionChoose,
  suggestStreet,
} from './solver'
import { ULTIMATE } from './variants'

const HANDS = Number(process.env.CELL_PLAY_HANDS ?? 0)
const MODEL = (process.env.CELL_PLAY_MODEL ?? 'policy') as 'policy' | 'streets' | 'combined'
const SEED = Number(process.env.CELL_PLAY_SEED ?? 0x5e11)
const ITERS = Number(process.env.CELL_PLAY_ITERS ?? 96)
const FOUL_W = process.env.CELL_PLAY_FOULW ? Number(process.env.CELL_PLAY_FOULW) : undefined
/** 第3ストリートの全列挙厳密評価（最終ストリートの厳密化は常時オンになった）。 */
const EXACT = process.env.CELL_PLAY_EXACT === '1'
/** 損失監査: FLを逃したハンドを後知恵と突き合わせて分類する。 */
const AUDIT = process.env.CELL_PLAY_AUDIT === '1'

describe('cell play: M[KK] B[653] sequential (set CELL_PLAY_HANDS to run)', () => {
  it.skipIf(HANDS <= 0)(`play streets with futureModel=${MODEL}`, () => {
    const start: Board = {
      top: [],
      middle: parseCards('Kd Kh'),
      bottom: parseCards('6d 5h 3h'),
    }
    const placed = [...start.middle, ...start.bottom]
    const rng = mulberry32(SEED)
    const deck = remainingDeck(placed, true)

    let fouls = 0
    let roySum = 0
    const entries: Record<number, number> = { 14: 0, 15: 0, 16: 0, 17: 0 }
    // 損失監査バケツ（FL逃しハンドの分類）
    const audit = { foul: 0, discardedKey: 0, jokerBuried: 0, routeMissed: 0, unlucky: 0 }
    const t0 = Date.now()
    for (let h = 0; h < HANDS; h++) {
      shuffle(deck, rng)
      let board: Board = { top: [...start.top], middle: [...start.middle], bottom: [...start.bottom] }
      const discards: Card[] = []
      for (let s = 0; s < 4; s++) {
        const drawn = deck.slice(s * 3, s * 3 + 3)
        const best = suggestStreet(board, drawn, discards, ULTIMATE, {
          iters: ITERS,
          jokers: true,
          rng,
          futureModel: MODEL,
          foulWeight: FOUL_W,
          endgameExact: EXACT,
        })[0]
        board = best.board
        if (best.discarded) discards.push(best.discarded)
      }
      const final = evaluateArrangement(board as Arrangement)
      let fl = 0
      if (final.fouled) fouls++
      else {
        roySum += royaltiesTotal(final)
        fl = fantasylandCards(final, ULTIMATE)
        if (fl > 0) entries[fl]++
      }
      if (AUDIT && fl === 0) {
        if (final.fouled) audit.foul++
        else {
          // 後知恵（12枚一括・4枚捨て自由）ならFLに届いたか
          const hind = bestCompletionChoose(start, deck.slice(0, 12), ULTIMATE, DEFAULT_FL_VALUES_JOKER)
          const hindFL =
            hind && !hind.evaluated.fouled ? fantasylandCards(hind.evaluated, ULTIMATE) : 0
          if (hindFL === 0) audit.unlucky++
          else if (discards.some((c) => c.rank === 0 || c.rank >= 12)) audit.discardedKey++
          else if (board.middle.some((c) => c.rank === 0) || board.bottom.some((c) => c.rank === 0))
            audit.jokerBuried++
          else audit.routeMissed++
        }
      }
      if ((h + 1) % 50 === 0) {
        console.log(`... ${h + 1}/${HANDS} (${Math.round((Date.now() - t0) / 1000)}s)`)
      }
    }

    const pct = (x: number) => ((100 * x) / HANDS).toFixed(1)
    const totalEntries = entries[14] + entries[15] + entries[16] + entries[17]
    const flSum = (t: Readonly<Record<number, number>>) =>
      [14, 15, 16, 17].reduce((a, n) => a + entries[n] * (t[n] ?? 0), 0)
    console.log(
      `[${MODEL} ${ITERS}iters seed=${SEED}${FOUL_W !== undefined ? ` foulW=${FOUL_W}` : ''}${EXACT ? ' exact-endgame' : ''}]`,
    )
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
    if (AUDIT) {
      console.log(
        `損失監査（FL未達 ${HANDS - totalEntries} ハンドの内訳）: ` +
          `ファウル:${pct(audit.foul)}% キー札捨て:${pct(audit.discardedKey)}% ` +
          `ジョーカー下段埋め:${pct(audit.jokerBuried)}% ルート逃し:${pct(audit.routeMissed)}% ` +
          `不運(後知恵でも不可):${pct(audit.unlucky)}%`,
      )
    }
    console.log(`(${Math.round((Date.now() - t0) / 1000)}s)`)
  }, 14_400_000)
})

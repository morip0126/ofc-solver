// oneshot 初手モデルのランキング妥当性プローブ:
// KK配牌（Kd Kh 6d 5h 3h）で、参考ソルバー#1と一致していた M[KK] B[653] 型が
// 上位に来るかを確認する。ONESHOT_RANK_ITERS 指定時のみ実行。
import { describe, it } from 'vitest'
import { cardsToString, parseCards } from './cards'
import { suggestInitial5 } from './solver'
import { ULTIMATE } from './variants'

const ITERS = Number(process.env.ONESHOT_RANK_ITERS ?? 0)

describe.skipIf(ITERS <= 0)('oneshot initial ranking on the KK hand', () => {
  it('rank all 232 placements', () => {
    const t0 = Date.now()
    const suggs = suggestInitial5(parseCards('Kd Kh 6d 5h 3h'), [], ULTIMATE, {
      futureModel: 'oneshot',
      iters: ITERS,
      jokers: true,
    })
    console.log(`(${Math.round((Date.now() - t0) / 1000)}s for 232 x ${ITERS})`)
    suggs.slice(0, 8).forEach((s, i) => {
      console.log(
        `#${i + 1} T[${cardsToString(s.board.top)}] M[${cardsToString(s.board.middle)}] B[${cardsToString(s.board.bottom)}] ` +
          `score=${s.score.toFixed(2)} FL=${(100 * s.flProb).toFixed(1)}% foul=${(100 * s.foulProb).toFixed(1)}%`,
      )
    })
    const kk653 = suggs.findIndex(
      (s) =>
        cardsToString(s.board.middle) === 'Kd Kh' && s.board.bottom.length === 3 && s.board.top.length === 0,
    )
    console.log(`M[KK] B[653] 型の順位: ${kk653 + 1}`)
  }, 14_400_000)
})

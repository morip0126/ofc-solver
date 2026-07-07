import { type Card, JOKER_CARDS, type Rank, type Suit, cardId } from '../domain'
import { isRedSuit, rankChar, suitSymbol } from './format'

const SUIT_ORDER: Suit[] = ['s', 'h', 'd', 'c']
const RANK_ORDER: Rank[] = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]

export function CardPicker({
  selected,
  canAdd,
  onToggle,
  jokers = false,
}: {
  /** 盤面のどこかで使用中のカードID。タップで取り除ける。 */
  selected: Set<number>
  /** 現在の選択先に追加できるか（false なら未使用カードを無効化）。 */
  canAdd: boolean
  onToggle: (card: Card) => void
  /** ジョーカー2枚入り（54枚デッキ）。true でジョーカーの行を表示する。 */
  jokers?: boolean
}) {
  return (
    <div className="card-picker" role="group" aria-label="card picker">
      {SUIT_ORDER.map((suit) => (
        <div className="picker-row" key={suit}>
          {RANK_ORDER.map((rank) => {
            const card: Card = { rank, suit }
            const id = cardId(card)
            const isSel = selected.has(id)
            const disabled = !canAdd && !isSel
            return (
              <button
                type="button"
                key={id}
                className={`picker-cell ${isRedSuit(suit) ? 'red' : 'black'} ${isSel ? 'sel' : ''}`}
                disabled={disabled}
                aria-pressed={isSel}
                onClick={() => onToggle(card)}
              >
                <span className="rank">{rankChar(rank)}</span>
                <span className="suit">{suitSymbol(suit)}</span>
              </button>
            )
          })}
        </div>
      ))}
      {jokers && (
        <div className="picker-row" key="jokers">
          {JOKER_CARDS.map((card) => {
            const id = cardId(card)
            const isSel = selected.has(id)
            const disabled = !canAdd && !isSel
            return (
              <button
                type="button"
                key={id}
                className={`picker-cell joker ${isSel ? 'sel' : ''}`}
                disabled={disabled}
                aria-pressed={isSel}
                onClick={() => onToggle(card)}
              >
                <span className="rank">🃏</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

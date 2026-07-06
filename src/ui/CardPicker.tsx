import { type Card, type Rank, type Suit, cardId } from '../domain'
import { isRedSuit, rankChar, suitSymbol } from './format'

const SUIT_ORDER: Suit[] = ['s', 'h', 'd', 'c']
const RANK_ORDER: Rank[] = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]

export function CardPicker({
  selected,
  canAdd,
  onToggle,
}: {
  /** 盤面のどこかで使用中のカードID。タップで取り除ける。 */
  selected: Set<number>
  /** 現在の選択先に追加できるか（false なら未使用カードを無効化）。 */
  canAdd: boolean
  onToggle: (card: Card) => void
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
    </div>
  )
}

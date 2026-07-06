// HandValue を i18n の役名に変換する。
import { HandCategory, type HandValue, categoryOf, isRoyalFlush } from '../domain'
import { type Lang, type MessageKey, t } from '../i18n'

const CATEGORY_KEY: Record<HandCategory, MessageKey> = {
  [HandCategory.StraightFlush]: 'handSF',
  [HandCategory.Quads]: 'handQuads',
  [HandCategory.FullHouse]: 'handFull',
  [HandCategory.Flush]: 'handFlush',
  [HandCategory.Straight]: 'handStraight',
  [HandCategory.Trips]: 'handTrips',
  [HandCategory.TwoPair]: 'handTwoPair',
  [HandCategory.Pair]: 'handPair',
  [HandCategory.HighCard]: 'handHigh',
}

export function handLabel(value: HandValue, lang: Lang): string {
  if (isRoyalFlush(value)) return t(lang, 'handRoyal')
  return t(lang, CATEGORY_KEY[categoryOf(value)])
}

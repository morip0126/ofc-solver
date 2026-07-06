// i18n（ja/en）。文言はここに集約し、t(lang, key) 経由で使う。JSX に直書きしない。

export type Lang = 'ja' | 'en'

const messages = {
  title: { ja: 'OFC ソルバー', en: 'OFC Solver' },
  subtitle: {
    ja: 'パイナップル OFC・13枚の最善配列',
    en: 'Pineapple OFC — best 13-card arrangement',
  },
  variant: { ja: '種類', en: 'Variant' },
  variantNormal: { ja: 'ノーマル', en: 'Normal' },
  variantUltimate: { ja: 'アルティメット', en: 'Ultimate' },
  pickPrompt: { ja: 'カードを13枚選択', en: 'Pick 13 cards' },
  selected: { ja: '選択', en: 'selected' },
  clear: { ja: 'クリア', en: 'Clear' },
  needCards: { ja: 'あと{n}枚選んでください', en: 'Pick {n} more card(s)' },
  solving: { ja: '計算中…', en: 'Solving…' },
  noValid: { ja: '非ファウルの配列が見つかりません', en: 'No non-fouling arrangement found' },
  top: { ja: 'トップ', en: 'Top' },
  middle: { ja: 'ミドル', en: 'Middle' },
  bottom: { ja: 'ボトム', en: 'Bottom' },
  royalties: { ja: 'ロイヤリティ', en: 'Royalties' },
  fantasyland: { ja: 'ファンタジーランド', en: 'Fantasyland' },
  flCards: { ja: '{n}枚', en: '{n} cards' },
  flNone: { ja: 'なし', en: 'none' },
  ev: { ja: '期待値 (EV)', en: 'EV' },
  estimateEv: { ja: 'EV を推定', en: 'Estimate EV' },
  estimatingEv: { ja: 'EV 推定中…', en: 'Estimating EV…' },
  evHint: {
    ja: 'ランダムな相手に対するヘッズアップ期待得点（モンテカルロ）',
    en: 'Heads-up expected score vs a random opponent (Monte Carlo)',
  },
  handSF: { ja: 'ストレートフラッシュ', en: 'Straight flush' },
  handQuads: { ja: 'フォーカード', en: 'Four of a kind' },
  handFull: { ja: 'フルハウス', en: 'Full house' },
  handFlush: { ja: 'フラッシュ', en: 'Flush' },
  handStraight: { ja: 'ストレート', en: 'Straight' },
  handTrips: { ja: 'スリーカード', en: 'Three of a kind' },
  handTwoPair: { ja: 'ツーペア', en: 'Two pair' },
  handPair: { ja: 'ワンペア', en: 'Pair' },
  handHigh: { ja: 'ハイカード', en: 'High card' },
  handRoyal: { ja: 'ロイヤルフラッシュ', en: 'Royal flush' },
} as const

export type MessageKey = keyof typeof messages

export function t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  let s: string = messages[key][lang]
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v))
  }
  return s
}

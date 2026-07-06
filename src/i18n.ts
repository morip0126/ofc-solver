// i18n（ja/en）。文言はここに集約し、t(lang, key) 経由で使う。JSX に直書きしない。

export type Lang = 'ja' | 'en'

const messages = {
  title: { ja: 'OFC ソルバー', en: 'OFC Solver' },
  subtitle: {
    ja: 'パイナップル OFC 実戦アシスタント',
    en: 'Pineapple OFC in-game assistant',
  },
  variant: { ja: '種類', en: 'Variant' },
  variantNormal: { ja: 'ノーマル', en: 'Normal' },
  variantUltimate: { ja: 'アルティメット', en: 'Ultimate' },
  deck: { ja: 'デッキ', en: 'Deck' },
  deck52: { ja: '52枚', en: '52 cards' },
  deck54: { ja: '54枚（ジョーカー入り）', en: '54 (jokers)' },
  players: { ja: '人数', en: 'Players' },
  playersHU: { ja: '2人', en: '2 (HU)' },
  players3: { ja: '3人', en: '3' },
  mode: { ja: 'モード', en: 'Mode' },
  modePlay: { ja: 'プレイ', en: 'Play' },
  modeFL: { ja: 'FL', en: 'FL' },
  reset: { ja: 'リセット', en: 'Reset' },
  undo: { ja: '戻す', en: 'Undo' },

  hero: { ja: 'Hero', en: 'Hero' },
  villainN: { ja: 'Villain {n}', en: 'Villain {n}' },
  top: { ja: 'トップ', en: 'Top' },
  middle: { ja: 'ミドル', en: 'Middle' },
  bottom: { ja: 'ボトム', en: 'Bottom' },
  discards: { ja: '捨て札', en: 'Discards' },

  pool: { ja: 'ドロー', en: 'Draw' },
  poolFL: { ja: 'FL 配牌', en: 'FL deal' },
  targetHint: {
    ja: '見出しをタップして選択先を切替え、下のカード表から追加。カードをタップで戻す。',
    en: 'Tap a heading to set the input target, then tap cards below. Tap a placed card to remove it.',
  },

  streetInitial: { ja: '初手', en: 'Initial' },
  streetN: { ja: 'ストリート {n}', en: 'Street {n}' },
  handComplete: { ja: '完成', en: 'Complete' },
  drawPrompt: { ja: 'ドローをあと{n}枚選んでください', en: 'Pick {n} more drawn card(s)' },
  assignHintInitial: {
    ja: '5枚すべての置き先を選んで確定（推奨手からも選べます）',
    en: 'Assign all 5 cards to rows, then confirm (or apply a suggestion)',
  },
  assignHintStreet: {
    ja: '2枚置き・1枚捨てを選んで確定（推奨手からも選べます）',
    en: 'Place 2, discard 1, then confirm (or apply a suggestion)',
  },
  boardShapeWarning: {
    ja: '盤面の形が通常の進行と合わないため推奨は出せません（枚数を確認してください）',
    en: 'Board shape does not match normal progression; suggestions unavailable',
  },
  commit: { ja: '確定', en: 'Confirm' },
  discardLabel: { ja: '捨て', en: 'Discard' },

  suggestions: { ja: '推奨手', en: 'Suggestions' },
  computing: { ja: '計算中… {pct}%', en: 'Computing… {pct}%' },
  apply: { ja: '採用', en: 'Apply' },
  expRoyalty: { ja: '期待Roy', en: 'Exp. roy.' },
  foulRisk: { ja: 'ファウル率', en: 'Foul' },
  flChance: { ja: 'FL率', en: 'FL' },
  suggScore: { ja: 'スコア', en: 'Score' },
  suggestHint: {
    ja: 'スコア = 期待ロイヤリティ + FL率ボーナス − ファウル率ペナルティ（楽観的補完のヒューリスティック）',
    en: 'Score = exp. royalties + FL bonus − foul penalty (optimistic-completion heuristic)',
  },

  royalties: { ja: 'ロイヤリティ', en: 'Royalties' },
  fantasyland: { ja: 'ファンタジーランド', en: 'Fantasyland' },
  flCards: { ja: '{n}枚', en: '{n} cards' },
  flNone: { ja: 'なし', en: 'none' },
  fouled: { ja: 'ファウル！', en: 'FOULED!' },

  ev: { ja: 'EV', en: 'EV' },
  estimateEv: { ja: 'EV を推定', en: 'Estimate EV' },
  estimatingEv: { ja: 'EV 推定中…', en: 'Estimating EV…' },
  evHint: {
    ja: 'ランダムな相手{n}人に対する期待得点（モンテカルロ、ペアワイズ採点）',
    en: 'Expected score vs {n} random opponent(s) (Monte Carlo, pairwise scoring)',
  },
  actualScore: { ja: '確定スコア', en: 'Final score' },
  vsVillainN: { ja: 'vs Villain {n}', en: 'vs Villain {n}' },
  totalScore: { ja: '合計', en: 'Total' },

  flPoolPrompt: {
    ja: 'FL の配牌（13〜17枚）を選んで「FL を解く」を押してください',
    en: 'Pick your FL deal (13–17 cards) and press "Solve FL"',
  },
  flSolve: { ja: 'FL を解く', en: 'Solve FL' },
  flSolving: { ja: 'FL 全探索中…', en: 'Solving FL…' },
  flBest: { ja: '最善配置 {n}', en: 'Best {n}' },
  stay: { ja: 'リステイ', en: 'Stays' },
  stayNo: { ja: 'リステイなし', en: 'No re-stay' },
  flHint: {
    ja: '目的値 = ロイヤリティ + リステイボーナス(6)。ファウルしない配置のみ。',
    en: 'Objective = royalties + re-stay bonus (6). Non-fouling arrangements only.',
  },

  noValid: { ja: '非ファウルの配列が見つかりません', en: 'No non-fouling arrangement found' },
  errorPrefix: { ja: 'エラー: {msg}', en: 'Error: {msg}' },

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

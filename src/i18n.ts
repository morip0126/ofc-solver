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
  precision: { ja: '精度', en: 'Precision' },
  precisionFast: { ja: '速い', en: 'Fast' },
  precisionStandard: { ja: '標準', en: 'Standard' },
  precisionHigh: { ja: '高精度', en: 'High' },
  confirmReset: {
    ja: '盤面をすべてリセットします。よろしいですか？',
    en: 'Reset the entire board?',
  },
  confirmDeckSwitch: {
    ja: 'デッキを切り替えると盤面がリセットされます。よろしいですか？',
    en: 'Switching decks resets the board. Continue?',
  },
  confirmModeSwitch: {
    ja: 'モードを切り替えると盤面がリセットされます。よろしいですか？',
    en: 'Switching modes resets the board. Continue?',
  },

  modeVs: { ja: '対戦', en: 'VS' },
  solverName: { ja: 'ソルバー', en: 'Solver' },
  vsIntro: {
    ja: 'ソルバーと1対1で対戦します。配牌は自動、捨て札は互いに非公開。先手（OOP）が先に置き、後手（IP）は相手の配置を見てから置けます。ポジションはハンドごとに交代。',
    en: 'Play heads-up against the solver. Dealing is automatic and discards are hidden. OOP places first each street; IP sees it before acting. Position alternates every hand.',
  },
  vsPosIP: { ja: '後手（IP）', en: 'IP (acts last)' },
  vsPosOOP: { ja: '先手（OOP）', en: 'OOP (acts first)' },
  vsWaitingVillain: { ja: 'ソルバーの配置待ち…', en: 'Waiting for solver…' },
  vsDeal: { ja: '配る', en: 'Deal' },
  vsNextHand: { ja: '次のハンド', en: 'Next hand' },
  vsThinking: { ja: '思考中…', en: 'thinking…' },
  vsResultWin: { ja: '勝ち！', en: 'You win!' },
  vsResultLose: { ja: '負け', en: 'You lose' },
  vsResultTie: { ja: '引き分け', en: 'Tie' },
  vsScore: { ja: 'このハンド', en: 'This hand' },
  vsYou: { ja: 'あなた', en: 'You' },
  vsStatsLine: {
    ja: '通算 {hands}ハンド / 勝率 {wr}% / 収支 {total}点',
    en: 'Session: {hands} hands / win {wr}% / total {total} pts',
  },
  vsResetStats: { ja: '通算成績をリセット', en: 'Reset stats' },
  vsRules: {
    ja: 'スコア = 各段の勝敗±1 + スクープ3 + ロイヤリティ差（ファウルは6点 + 相手ロイヤリティ献上）',
    en: 'Score = ±1 per row + 3 scoop + royalty diff (foul concedes 6 + opponent royalties)',
  },

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
    ja: '置き先の段をタップで選択し、カードをタップで割当てて確定（推奨手の採用も可）',
    en: 'Tap a row to select it, tap cards to assign, then confirm (or apply a suggestion)',
  },
  assignHintStreet: {
    ja: '段を選択して2枚を割当てると、残り1枚が自動で捨て札になります（推奨手の採用も可）',
    en: 'Select a row and assign 2 cards; the last one is discarded automatically (or apply a suggestion)',
  },
  vsAssignHintInitial: {
    ja: '置き先の段をタップで選択し、カードをタップで割当てて確定',
    en: 'Tap a row to select it, tap cards to assign, then confirm',
  },
  vsAssignHintStreet: {
    ja: '段を選択して2枚を割当てると、残り1枚が自動で捨て札になります',
    en: 'Select a row and assign 2 cards; the last one is discarded automatically',
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
    ja: '目的値 = ロイヤリティ + リステイボーナス({bonus} = 実測したFL継続の期待価値)ファウルしない配置のみ。',
    en: 'Objective = royalties + re-stay bonus ({bonus}, the measured EV of staying). Non-fouling arrangements only.',
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

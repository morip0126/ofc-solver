// localStorage 永続化。設定と進行中の盤面をリロード後も復元する。
// - キー名にスキーマバージョンを含める。将来形式を変えるときはキーを上げて旧データは無視する。
// - 壊れた/不正なデータは黙って破棄して既定値で起動する（起動を妨げない）。
// - private mode 等で localStorage が使えない環境でも例外を漏らさない。

import {
  type Card,
  ROW_CAP,
  type RowKey,
  type VariantId,
  cardId,
  cardToString,
  parseCards,
} from './domain'

export type Precision = 'fast' | 'standard' | 'high'

export interface PersistedSettings {
  lang: 'ja' | 'en'
  variantId: VariantId
  players: 2 | 3
  mode: 'play' | 'fl' | 'vs'
  useJokers: boolean
  precision: Precision
}

export interface GameBoard {
  top: Card[]
  middle: Card[]
  bottom: Card[]
}

export interface GameSnapshot {
  hero: GameBoard
  heroDiscards: Card[]
  pool: Card[]
  assign: Record<number, RowKey>
}

/** 対戦モード（vs ソルバー）の進行状態。デッキ・ソルバー手札込みで保存し、リロード後も続行できる。 */
export interface VsState {
  /** 未配布の山札（シャッフル済み、先頭から配る）。 */
  deck: Card[]
  /** ソルバーが受け取って未配置の手札（思考中/未処理）。 */
  villainHand: Card[] | null
  /** ソルバー自身の捨て札（ソルバーだけが知っている dead）。 */
  villainDiscards: Card[]
  /** このハンドを通算成績に加算済みか（リロード時の二重加算防止）。 */
  scored: boolean
  /** Hero が IP（後手 = 相手の配置を見てから置ける）か。ハンドごとに交代する。 */
  heroIsIP: boolean
  /** 現在のハンドで Hero が FL 中なら配牌枚数（13〜17）、通常ハンドは 0。 */
  heroFL: number
  /** 現在のハンドでソルバーが FL 中なら配牌枚数、通常ハンドは 0。 */
  villainFL: number
  /** ハンド終了時に確定した、次ハンドの FL 枚数（突入 / リステイ）。 */
  pendingHeroFL: number
  pendingVillainFL: number
}

export interface PersistedGame {
  hero: GameBoard
  heroDiscards: Card[]
  villains: [GameBoard, GameBoard]
  pool: Card[]
  assign: Record<number, RowKey>
  history: GameSnapshot[]
  vs: VsState | null
}

export interface VsPosStats {
  hands: number
  wins: number
  total: number
}

/** プレイヤー（Hero / ソルバー）ごとの詳細成績。 */
export interface VsPlayerStats {
  /** 通常ハンド数（FL でないハンド）。FL 突入率の分母。 */
  normalHands: number
  /** FL 突入回数（配牌枚数別、14〜17）。 */
  flEntries: Record<number, number>
  /** FL ハンド数（配牌枚数別）。FL 継続率の分母。 */
  flHands: Record<number, number>
  /** FL リステイ回数（そのハンドの配牌枚数別）。 */
  flStays: Record<number, number>
  /** 素点（対戦スコア）の合計。平均素点 = scoreTotal / (normalHands + FLハンド数)。 */
  scoreTotal: number
}

/** 対戦モードの通算成績（全体 + ポジション別 + プレイヤー別詳細）。 */
export interface VsStats extends VsPosStats {
  oop: VsPosStats
  ip: VsPosStats
  hero: VsPlayerStats
  villain: VsPlayerStats
}

const zeroPosStats = (): VsPosStats => ({ hands: 0, wins: 0, total: 0 })

const zeroPlayerStats = (): VsPlayerStats => ({
  normalHands: 0,
  flEntries: {},
  flHands: {},
  flStays: {},
  scoreTotal: 0,
})

export const emptyVsStats = (): VsStats => ({
  ...zeroPosStats(),
  oop: zeroPosStats(),
  ip: zeroPosStats(),
  hero: zeroPlayerStats(),
  villain: zeroPlayerStats(),
})

const SETTINGS_KEY = 'ofc-solver:settings:v1'
const GAME_KEY = 'ofc-solver:game:v1'
const HISTORY_CAP = 30

const ROWS: readonly RowKey[] = ['top', 'middle', 'bottom']

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function readJSON(key: string): unknown {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

function writeJSON(key: string, value: unknown): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(key, JSON.stringify(value))
  } catch {
    // 容量超過・private mode などは無視（永続化はベストエフォート）。
  }
}

// ---- 設定 ----------------------------------------------------------------------

function oneOf<T extends string | number | boolean>(v: unknown, allowed: readonly T[]): T | null {
  return allowed.includes(v as T) ? (v as T) : null
}

/** 保存済み設定を読み込む。各フィールドは値を検証し、無効なものは含めない。 */
export function loadSettings(): Partial<PersistedSettings> {
  const raw = readJSON(SETTINGS_KEY)
  if (typeof raw !== 'object' || raw === null) return {}
  const o = raw as Record<string, unknown>
  const out: Partial<PersistedSettings> = {}
  const lang = oneOf(o.lang, ['ja', 'en'] as const)
  if (lang) out.lang = lang
  const variantId = oneOf(o.variantId, ['normal', 'ultimate'] as const)
  if (variantId) out.variantId = variantId as VariantId
  const players = oneOf(o.players, [2, 3] as const)
  if (players) out.players = players
  const mode = oneOf(o.mode, ['play', 'fl', 'vs'] as const)
  if (mode) out.mode = mode
  if (typeof o.useJokers === 'boolean') out.useJokers = o.useJokers
  const precision = oneOf(o.precision, ['fast', 'standard', 'high'] as const)
  if (precision) out.precision = precision
  return out
}

export function saveSettings(settings: PersistedSettings): void {
  writeJSON(SETTINGS_KEY, settings)
}

// ---- 盤面 ----------------------------------------------------------------------

interface BoardCodes {
  top: string[]
  middle: string[]
  bottom: string[]
}

function boardToCodes(b: GameBoard): BoardCodes {
  return {
    top: b.top.map(cardToString),
    middle: b.middle.map(cardToString),
    bottom: b.bottom.map(cardToString),
  }
}

function snapshotToCodes(s: GameSnapshot) {
  return {
    hero: boardToCodes(s.hero),
    heroDiscards: s.heroDiscards.map(cardToString),
    pool: s.pool.map(cardToString),
    assign: s.assign,
  }
}

export function saveGame(game: PersistedGame): void {
  writeJSON(GAME_KEY, {
    hero: boardToCodes(game.hero),
    heroDiscards: game.heroDiscards.map(cardToString),
    villains: game.villains.map(boardToCodes),
    pool: game.pool.map(cardToString),
    assign: game.assign,
    history: game.history.slice(-HISTORY_CAP).map(snapshotToCodes),
    vs: game.vs
      ? {
          deck: game.vs.deck.map(cardToString),
          villainHand: game.vs.villainHand ? game.vs.villainHand.map(cardToString) : null,
          villainDiscards: game.vs.villainDiscards.map(cardToString),
          scored: game.vs.scored,
          heroIsIP: game.vs.heroIsIP,
          heroFL: game.vs.heroFL,
          villainFL: game.vs.villainFL,
          pendingHeroFL: game.vs.pendingHeroFL,
          pendingVillainFL: game.vs.pendingVillainFL,
        }
      : null,
  })
}

export function clearGame(): void {
  const s = storage()
  try {
    s?.removeItem(GAME_KEY)
  } catch {
    // ignore
  }
}

function parseCodes(v: unknown, jokersAllowed: boolean): Card[] {
  if (!Array.isArray(v) || v.some((c) => typeof c !== 'string')) throw new Error('bad cards')
  const cards = parseCards(v as string[])
  if (!jokersAllowed && cards.some((c) => c.rank === 0)) throw new Error('joker in 52-deck state')
  return cards
}

function parseBoard(v: unknown, jokersAllowed: boolean): GameBoard {
  if (typeof v !== 'object' || v === null) throw new Error('bad board')
  const o = v as Record<string, unknown>
  const board: GameBoard = {
    top: parseCodes(o.top ?? [], jokersAllowed),
    middle: parseCodes(o.middle ?? [], jokersAllowed),
    bottom: parseCodes(o.bottom ?? [], jokersAllowed),
  }
  for (const row of ROWS) {
    if (board[row].length > ROW_CAP[row]) throw new Error('row over cap')
  }
  return board
}

function parseAssign(v: unknown, pool: Card[]): Record<number, RowKey> {
  if (typeof v !== 'object' || v === null) return {}
  const ids = new Set(pool.map(cardId))
  const out: Record<number, RowKey> = {}
  for (const [k, row] of Object.entries(v as Record<string, unknown>)) {
    const id = Number(k)
    if (!Number.isInteger(id) || !ids.has(id)) continue
    if (row === 'top' || row === 'middle' || row === 'bottom') out[id] = row
  }
  return out
}

function parseSnapshot(v: unknown, jokersAllowed: boolean): GameSnapshot {
  if (typeof v !== 'object' || v === null) throw new Error('bad snapshot')
  const o = v as Record<string, unknown>
  const hero = parseBoard(o.hero, jokersAllowed)
  const heroDiscards = parseCodes(o.heroDiscards ?? [], jokersAllowed)
  const pool = parseCodes(o.pool ?? [], jokersAllowed)
  return { hero, heroDiscards, pool, assign: parseAssign(o.assign, pool) }
}

/** 全ゾーンを合わせてカードが重複していないこと。 */
function assertNoDuplicates(zones: readonly (readonly Card[])[]): void {
  const seen = new Set<number>()
  for (const zone of zones) {
    for (const c of zone) {
      const id = cardId(c)
      if (seen.has(id)) throw new Error('duplicate card')
      seen.add(id)
    }
  }
}

/**
 * 保存済みの進行中盤面を読み込む。デッキ設定（useJokers）と矛盾する状態・重複カード・
 * 形式不正はすべて null（復元しない）にフォールバックする。
 */
export function loadGame(useJokers: boolean): PersistedGame | null {
  const raw = readJSON(GAME_KEY)
  if (typeof raw !== 'object' || raw === null) return null
  try {
    const o = raw as Record<string, unknown>
    const hero = parseBoard(o.hero, useJokers)
    const heroDiscards = parseCodes(o.heroDiscards ?? [], useJokers)
    const pool = parseCodes(o.pool ?? [], useJokers)
    if (pool.length > 17) throw new Error('pool too large')
    const villainsRaw = Array.isArray(o.villains) ? o.villains : []
    const villains: [GameBoard, GameBoard] = [
      parseBoard(villainsRaw[0] ?? { top: [], middle: [], bottom: [] }, useJokers),
      parseBoard(villainsRaw[1] ?? { top: [], middle: [], bottom: [] }, useJokers),
    ]
    let vs: VsState | null = null
    if (typeof o.vs === 'object' && o.vs !== null) {
      const vsRaw = o.vs as Record<string, unknown>
      const deck = parseCodes(vsRaw.deck ?? [], useJokers)
      if (deck.length > 54) throw new Error('vs deck too large')
      const flNum = (v: unknown) =>
        typeof v === 'number' && Number.isInteger(v) && v >= 13 && v <= 17 ? v : 0
      vs = {
        deck,
        villainHand: vsRaw.villainHand == null ? null : parseCodes(vsRaw.villainHand, useJokers),
        villainDiscards: parseCodes(vsRaw.villainDiscards ?? [], useJokers),
        scored: vsRaw.scored === true,
        heroIsIP: vsRaw.heroIsIP === true,
        heroFL: flNum(vsRaw.heroFL),
        villainFL: flNum(vsRaw.villainFL),
        pendingHeroFL: flNum(vsRaw.pendingHeroFL),
        pendingVillainFL: flNum(vsRaw.pendingVillainFL),
      }
    }
    assertNoDuplicates([
      hero.top,
      hero.middle,
      hero.bottom,
      heroDiscards,
      pool,
      ...villains.flatMap((v) => [v.top, v.middle, v.bottom]),
      ...(vs ? [vs.deck, vs.villainHand ?? [], vs.villainDiscards] : []),
    ])
    const historyRaw = Array.isArray(o.history) ? o.history : []
    const history = historyRaw.slice(-HISTORY_CAP).map((s) => parseSnapshot(s, useJokers))
    return {
      hero,
      heroDiscards,
      villains,
      pool,
      assign: parseAssign(o.assign, pool),
      history,
      vs,
    }
  } catch {
    return null
  }
}

// ---- 対戦モードの通算成績 --------------------------------------------------------
// v2: ルール構成（種類 × デッキ）ごとに独立して積み上げる。

/** ルール構成キー（例: "normal-52", "ultimate-54"）。 */
export type VsConfigKey = `${VariantId}-${'52' | '54'}`

export function vsConfigKey(variantId: VariantId, jokers: boolean): VsConfigKey {
  return `${variantId}-${jokers ? '54' : '52'}`
}

export type VsStatsByConfig = Partial<Record<VsConfigKey, VsStats>>

const VS_STATS_KEY_V2 = 'ofc-solver:vsStats:v2'
const VS_STATS_KEY_V1 = 'ofc-solver:vsStats:v1'

const VS_CONFIG_KEYS: readonly VsConfigKey[] = [
  'normal-52',
  'normal-54',
  'ultimate-52',
  'ultimate-54',
]

function parsePosStats(v: unknown): VsPosStats {
  if (typeof v !== 'object' || v === null) return zeroPosStats()
  const o = v as Record<string, unknown>
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return { hands: num(o.hands), wins: num(o.wins), total: num(o.total) }
}

/** FL 枚数（13〜17）をキーとするカウント表のパース。 */
function parseFLRecord(v: unknown): Record<number, number> {
  if (typeof v !== 'object' || v === null) return {}
  const out: Record<number, number> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(k)
    if (
      Number.isInteger(n) &&
      n >= 13 &&
      n <= 17 &&
      typeof val === 'number' &&
      Number.isFinite(val) &&
      val >= 0
    ) {
      out[n] = val
    }
  }
  return out
}

function parsePlayerStats(v: unknown): VsPlayerStats {
  if (typeof v !== 'object' || v === null) return zeroPlayerStats()
  const o = v as Record<string, unknown>
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return {
    normalHands: num(o.normalHands),
    flEntries: parseFLRecord(o.flEntries),
    flHands: parseFLRecord(o.flHands),
    flStays: parseFLRecord(o.flStays),
    scoreTotal: num(o.scoreTotal),
  }
}

function parseVsStats(v: unknown): VsStats {
  if (typeof v !== 'object' || v === null) return emptyVsStats()
  const o = v as Record<string, unknown>
  return {
    ...parsePosStats(v),
    oop: parsePosStats(o.oop),
    ip: parsePosStats(o.ip),
    hero: parsePlayerStats(o.hero),
    villain: parsePlayerStats(o.villain),
  }
}

export function loadVsStatsByConfig(): VsStatsByConfig {
  const raw = readJSON(VS_STATS_KEY_V2)
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>
    const out: VsStatsByConfig = {}
    for (const key of VS_CONFIG_KEYS) {
      if (typeof o[key] === 'object' && o[key] !== null) out[key] = parseVsStats(o[key])
    }
    return out
  }
  // v1（構成別なし）からの移行: 既定構成（ノーマル / 52枚）の成績として引き継ぐ。
  const v1 = readJSON(VS_STATS_KEY_V1)
  if (typeof v1 === 'object' && v1 !== null) {
    const migrated = parseVsStats(v1)
    if (migrated.hands > 0) return { 'normal-52': migrated }
  }
  return {}
}

export function saveVsStatsByConfig(stats: VsStatsByConfig): void {
  writeJSON(VS_STATS_KEY_V2, stats)
}

/** 初回起動時の言語既定値（ブラウザ設定から推定）。 */
export function detectLang(): 'ja' | 'en' {
  if (typeof navigator === 'undefined') return 'ja'
  return (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

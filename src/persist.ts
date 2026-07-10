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

/** 対戦モードの通算成績（全体 + ポジション別）。 */
export interface VsStats extends VsPosStats {
  oop: VsPosStats
  ip: VsPosStats
}

const zeroPosStats = (): VsPosStats => ({ hands: 0, wins: 0, total: 0 })

export const emptyVsStats = (): VsStats => ({
  ...zeroPosStats(),
  oop: zeroPosStats(),
  ip: zeroPosStats(),
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
      vs = {
        deck,
        villainHand: vsRaw.villainHand == null ? null : parseCodes(vsRaw.villainHand, useJokers),
        villainDiscards: parseCodes(vsRaw.villainDiscards ?? [], useJokers),
        scored: vsRaw.scored === true,
        heroIsIP: vsRaw.heroIsIP === true,
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

const VS_STATS_KEY = 'ofc-solver:vsStats:v1'

function parsePosStats(v: unknown): VsPosStats {
  if (typeof v !== 'object' || v === null) return zeroPosStats()
  const o = v as Record<string, unknown>
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return { hands: num(o.hands), wins: num(o.wins), total: num(o.total) }
}

/** 旧形式（ポジション別なし）は全体成績のみ引き継ぎ、内訳はゼロから積み上げる。 */
export function loadVsStats(): VsStats {
  const raw = readJSON(VS_STATS_KEY)
  if (typeof raw !== 'object' || raw === null) return emptyVsStats()
  const o = raw as Record<string, unknown>
  return { ...parsePosStats(raw), oop: parsePosStats(o.oop), ip: parsePosStats(o.ip) }
}

export function saveVsStats(stats: VsStats): void {
  writeJSON(VS_STATS_KEY, stats)
}

/** 初回起動時の言語既定値（ブラウザ設定から推定）。 */
export function detectLang(): 'ja' | 'en' {
  if (typeof navigator === 'undefined') return 'ja'
  return (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

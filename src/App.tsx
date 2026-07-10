import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Card,
  DEFAULT_STAY_BONUS,
  DEFAULT_STAY_BONUS_JOKER,
  ROW_CAP,
  type RowKey,
  type VariantId,
  VARIANTS,
  cardId,
  cardToString,
  evaluateArrangement,
  fantasylandCards,
  makeDeck,
  parseCards,
  royaltiesTotal,
  scoreEvaluated,
  scoreMultiEvaluated,
  shuffle,
} from './domain'
import { type Lang, type MessageKey, t } from './i18n'
import { CardGlyph } from './ui/CardGlyph'
import { CardPicker } from './ui/CardPicker'
import { handLabel } from './ui/handLabel'
import { evaluate3, evaluate5 } from './domain'
import type { FLResultDTO, SuggestionDTO } from './worker/solver.worker'
import {
  CanceledError,
  type EvResult,
  type PoolTask,
  estimateEvParallel,
  solveFLParallel,
  solverPool,
  suggestInitialParallel,
  suggestStreetParallel,
} from './worker/solverClient'
import {
  type Precision,
  type VsPosStats,
  type VsStats,
  type VsStatsByConfig,
  detectLang,
  emptyVsStats,
  loadGame,
  loadSettings,
  loadVsStatsByConfig,
  saveGame,
  saveSettings,
  saveVsStatsByConfig,
  vsConfigKey,
} from './persist'

// ---- 型・ヘルパー -------------------------------------------------------------

interface PB {
  top: Card[]
  middle: Card[]
  bottom: Card[]
}

type Mode = 'play' | 'fl' | 'vs'

type Target =
  | { kind: 'pool' }
  | { kind: 'hero'; row: RowKey }
  | { kind: 'villain'; idx: number; row: RowKey }

const ROWS: readonly RowKey[] = ['top', 'middle', 'bottom']
const FL_MAX = 17

const emptyBoard = (): PB => ({ top: [], middle: [], bottom: [] })
const cloneBoard = (b: PB): PB => ({ top: [...b.top], middle: [...b.middle], bottom: [...b.bottom] })
const boardCount = (b: PB) => b.top.length + b.middle.length + b.bottom.length
const boardCards = (b: PB) => [...b.top, ...b.middle, ...b.bottom]
const codesOf = (cards: readonly Card[]) => cards.map(cardToString).join(' ')

function removeCardFromBoard(b: PB, id: number): PB | null {
  for (const row of ROWS) {
    if (b[row].some((c) => cardId(c) === id)) {
      const nb = cloneBoard(b)
      nb[row] = nb[row].filter((c) => cardId(c) !== id)
      return nb
    }
  }
  return null
}

interface Snapshot {
  hero: PB
  heroDiscards: Card[]
  pool: Card[]
  assign: Record<number, RowKey>
}

/** 精度設定ごとのモンテカルロ反復数。Worker プールで並列実行される前提の値。 */
const PRECISION_ITERS: Record<Precision, { initial: number; street: number; ev: number }> = {
  fast: { initial: 60, street: 80, ev: 150 },
  standard: { initial: 160, street: 200, ev: 400 },
  high: { initial: 400, street: 500, ev: 1200 },
}

/** 対戦モードの完了ラウンド数（0 = 未配置, 1 = 初手済, 2..5 = 各ストリート済）。 */
function roundOf(count: number): number {
  return count <= 0 ? 0 : count <= 5 ? 1 : Math.min(5, 1 + Math.floor((count - 5) / 2))
}

// ---- 本体 ---------------------------------------------------------------------

export default function App() {
  // 初回マウント時に localStorage から設定と進行中の盤面を復元する。
  const [boot] = useState(() => {
    const settings = loadSettings()
    return { settings, game: loadGame(settings.useJokers ?? false) }
  })

  const [lang, setLang] = useState<Lang>(boot.settings.lang ?? detectLang())
  const [variantId, setVariantId] = useState<VariantId>(boot.settings.variantId ?? 'normal')
  const [players, setPlayersState] = useState<2 | 3>(boot.settings.players ?? 2)
  const [mode, setModeState] = useState<Mode>(boot.settings.mode ?? 'play')
  const [useJokers, setUseJokersState] = useState(boot.settings.useJokers ?? false)
  const [precision, setPrecision] = useState<Precision>(boot.settings.precision ?? 'standard')

  const [hero, setHero] = useState<PB>(boot.game?.hero ?? emptyBoard)
  const [heroDiscards, setHeroDiscards] = useState<Card[]>(boot.game?.heroDiscards ?? [])
  const [villains, setVillains] = useState<[PB, PB]>(
    boot.game?.villains ?? [emptyBoard(), emptyBoard()],
  )
  const [pool, setPool] = useState<Card[]>(boot.game?.pool ?? [])
  const [assign, setAssign] = useState<Record<number, RowKey>>(boot.game?.assign ?? {})
  /** 選択中のプールカード（このカードを次にタップした段へ置く）。 */
  const [selectedPoolId, setSelectedPoolId] = useState<number | null>(null)
  const [target, setTarget] = useState<Target>({ kind: 'pool' })
  const [history, setHistory] = useState<Snapshot[]>(boot.game?.history ?? [])

  const [sugg, setSugg] = useState<SuggestionDTO[] | null>(null)
  const [suggBusy, setSuggBusy] = useState(false)
  const [suggProgress, setSuggProgress] = useState(0)
  const [suggError, setSuggError] = useState<string | null>(null)

  const [flResults, setFlResults] = useState<FLResultDTO[] | null>(null)
  const [flBusy, setFlBusy] = useState(false)
  const [flError, setFlError] = useState<string | null>(null)

  const [ev, setEv] = useState<EvResult | null>(null)
  const [evBusy, setEvBusy] = useState(false)
  const [flProgress, setFlProgress] = useState(0)

  // ---- 対戦モード（vs ソルバー）----
  const [vsDeck, setVsDeck] = useState<Card[]>(boot.game?.vs?.deck ?? [])
  const [vsVillainHand, setVsVillainHand] = useState<Card[] | null>(
    boot.game?.vs?.villainHand ?? null,
  )
  const [vsVillainDiscards, setVsVillainDiscards] = useState<Card[]>(
    boot.game?.vs?.villainDiscards ?? [],
  )
  const [vsScored, setVsScored] = useState(boot.game?.vs?.scored ?? false)
  const [vsHeroIsIP, setVsHeroIsIP] = useState(boot.game?.vs?.heroIsIP ?? false)
  const [vsBusy, setVsBusy] = useState(false)
  const [vsError, setVsError] = useState<string | null>(null)
  const [vsStatsAll, setVsStatsAll] = useState<VsStatsByConfig>(() => loadVsStatsByConfig())

  const suggTask = useRef<PoolTask<SuggestionDTO[]> | null>(null)
  const flTask = useRef<PoolTask<FLResultDTO[]> | null>(null)
  const evTask = useRef<PoolTask<EvResult> | null>(null)
  const vsTask = useRef<PoolTask<SuggestionDTO[]> | null>(null)

  useEffect(() => {
    // Worker プールを先に温めて初回推奨の体感を短くする。
    solverPool.warmup()
    return () => {
      suggTask.current?.cancel()
      flTask.current?.cancel()
      evTask.current?.cancel()
      vsTask.current?.cancel()
    }
  }, [])

  // ---- 派生値 ----
  const shownVillains = useMemo(
    () => villains.slice(0, players - 1) as PB[],
    [villains, players],
  )
  const heroCount = boardCount(hero)
  const expectedDraw = mode === 'fl' ? FL_MAX : heroCount === 0 ? 5 : heroCount >= 13 ? 0 : 3
  // 対戦モードでハンドが進行中か（山札・配牌・盤面のいずれかにカードがある）。
  const vsHandActive =
    mode === 'vs' &&
    (vsDeck.length > 0 ||
      pool.length > 0 ||
      heroCount > 0 ||
      vsVillainHand !== null ||
      boardCount(villains[0]) > 0)

  const dead = useMemo(
    () => [...shownVillains.flatMap(boardCards), ...heroDiscards],
    [shownVillains, heroDiscards],
  )

  const usedIds = useMemo(() => {
    const ids = new Set<number>()
    for (const c of boardCards(hero)) ids.add(cardId(c))
    for (const v of shownVillains) for (const c of boardCards(v)) ids.add(cardId(c))
    for (const c of heroDiscards) ids.add(cardId(c))
    for (const c of pool) ids.add(cardId(c))
    return ids
  }, [hero, shownVillains, heroDiscards, pool])

  const canAdd = useMemo(() => {
    if (target.kind === 'pool') {
      return mode === 'fl' ? pool.length < FL_MAX : pool.length < expectedDraw
    }
    const board = target.kind === 'hero' ? hero : shownVillains[target.idx]
    if (!board) return false
    return board[target.row].length < ROW_CAP[target.row]
  }, [target, mode, pool.length, expectedDraw, hero, shownVillains])

  // 依存キー（文字列化して effect の再実行を安定させる）
  const heroCodes = useMemo(
    () => ROWS.map((r) => codesOf(hero[r])).join('|'),
    [hero],
  )
  const poolCodes = useMemo(() => codesOf(pool), [pool])
  const deadCodes = useMemo(() => codesOf(dead), [dead])

  // ---- 永続化（設定・進行中の盤面）----
  useEffect(() => {
    saveSettings({ lang, variantId, players, mode, useJokers, precision })
  }, [lang, variantId, players, mode, useJokers, precision])

  useEffect(() => {
    saveGame({
      hero,
      heroDiscards,
      villains,
      pool,
      assign,
      history,
      vs: {
        deck: vsDeck,
        villainHand: vsVillainHand,
        villainDiscards: vsVillainDiscards,
        scored: vsScored,
        heroIsIP: vsHeroIsIP,
      },
    })
  }, [hero, heroDiscards, villains, pool, assign, history, vsDeck, vsVillainHand, vsVillainDiscards, vsScored, vsHeroIsIP])

  // ---- 入力操作 ----
  const setPlayers = useCallback((n: 2 | 3) => {
    setPlayersState(n)
    if (n === 2) setVillains((v) => [v[0], emptyBoard()])
    setTarget({ kind: 'pool' })
  }, [])

  const clearAll = useCallback(() => {
    setHero(emptyBoard())
    setHeroDiscards([])
    setVillains([emptyBoard(), emptyBoard()])
    setPool([])
    setAssign({})
    setSelectedPoolId(null)
    setHistory([])
    setSugg(null)
    setFlResults(null)
    setEv(null)
    setTarget({ kind: 'pool' })
    setVsDeck([])
    setVsVillainHand(null)
    setVsVillainDiscards([])
    setVsScored(false)
    setVsError(null)
  }, [])

  const setMode = useCallback(
    (m: Mode) => {
      if (m === mode) return
      // 対戦モードは専用のデッキ進行を持つため、跨ぐ切替では盤面をクリアする。
      if (m === 'vs' || mode === 'vs') {
        if (usedIds.size > 0 && !window.confirm(t(lang, 'confirmModeSwitch'))) return
        clearAll()
      }
      setModeState(m)
      setPool([])
      setAssign({})
      setSelectedPoolId(null)
      setSugg(null)
      setFlResults(null)
      setFlError(null)
      setEv(null)
      setTarget({ kind: 'pool' })
    },
    [mode, usedIds, lang, clearAll],
  )

  // リセットは破壊的なので、カードが置かれているときは確認してから。
  const resetAll = useCallback(() => {
    if (usedIds.size > 0 && !window.confirm(t(lang, 'confirmReset'))) return
    clearAll()
  }, [usedIds, lang, clearAll])

  // デッキ切替（ジョーカー有無）は盤面のカードと整合しなくなるため全リセットする。
  const setUseJokers = useCallback(
    (on: boolean) => {
      if (on === useJokers) return
      if (usedIds.size > 0 && !window.confirm(t(lang, 'confirmDeckSwitch'))) return
      setUseJokersState(on)
      clearAll()
    },
    [useJokers, usedIds, lang, clearAll],
  )

  const pushHistory = useCallback(() => {
    setHistory((h) => [
      ...h,
      { hero: cloneBoard(hero), heroDiscards: [...heroDiscards], pool: [...pool], assign: { ...assign } },
    ])
  }, [hero, heroDiscards, pool, assign])

  const undo = useCallback(() => {
    setHistory((h) => {
      const last = h[h.length - 1]
      if (!last) return h
      setHero(last.hero)
      setHeroDiscards(last.heroDiscards)
      setPool(last.pool)
      setAssign(last.assign)
      setEv(null)
      return h.slice(0, -1)
    })
  }, [])

  const onPickerToggle = useCallback(
    (card: Card) => {
      // 対戦モードでは配牌は自動なので手動での追加/取り除きは無効。
      if (mode === 'vs') return
      const id = cardId(card)
      if (usedIds.has(id)) {
        // どこにあっても取り除く
        setSelectedPoolId((s) => (s === id ? null : s))
        setPool((p) => p.filter((c) => cardId(c) !== id))
        setAssign((a) => {
          if (!(id in a)) return a
          const na = { ...a }
          delete na[id]
          return na
        })
        setHeroDiscards((d) => d.filter((c) => cardId(c) !== id))
        setHero((b) => removeCardFromBoard(b, id) ?? b)
        setVillains((vs) => {
          const nv: [PB, PB] = [vs[0], vs[1]]
          for (let i = 0; i < 2; i++) {
            const nb = removeCardFromBoard(nv[i], id)
            if (nb) nv[i] = nb
          }
          return nv
        })
        return
      }
      if (!canAdd) return
      if (target.kind === 'pool') {
        setPool((p) => [...p, card])
      } else if (target.kind === 'hero') {
        const row = target.row
        setHero((b) => {
          if (b[row].length >= ROW_CAP[row]) return b
          const nb = cloneBoard(b)
          nb[row] = [...nb[row], card]
          return nb
        })
      } else {
        const { idx, row } = target
        setVillains((vs) => {
          const board = vs[idx]
          if (board[row].length >= ROW_CAP[row]) return vs
          const nb = cloneBoard(board)
          nb[row] = [...nb[row], card]
          const nv: [PB, PB] = [vs[0], vs[1]]
          nv[idx] = nb
          return nv
        })
      }
    },
    [mode, usedIds, canAdd, target],
  )

  // プールのカードをタップ: そのカードを選択する（次にタップした段へ置く）。
  // 選択中のカードをもう一度タップすると、割当があれば解除、なければ選択解除。
  // ドローが揃う前は従来どおり取り除き（手入力の修正用）。
  const onPoolCardTap = useCallback(
    (card: Card) => {
      const id = cardId(card)
      if (pool.length !== expectedDraw) {
        onPickerToggle(card)
        return
      }
      if (selectedPoolId === id) {
        setAssign((a) => (id in a ? removeKey(a, id) : a))
        setSelectedPoolId(null)
      } else {
        setSelectedPoolId(id)
      }
    },
    [pool.length, expectedDraw, selectedPoolId, onPickerToggle],
  )

  // 選択中のプールカードが有効か（プールに存在し、ドローが揃っている）。
  const selectedActive =
    selectedPoolId !== null &&
    pool.length === expectedDraw &&
    mode !== 'fl' &&
    pool.some((c) => cardId(c) === selectedPoolId)

  /** 選択中カードを除いて数えたとき、この段にまだ空きがあるか。 */
  const rowHasSpace = useCallback(
    (row: RowKey) => {
      const already = Object.entries(assign).filter(
        ([k, r]) => Number(k) !== selectedPoolId && r === row,
      ).length
      return hero[row].length + already < ROW_CAP[row]
    },
    [assign, selectedPoolId, hero],
  )

  // Hero の段をタップ: カード選択中ならそこへ置く。未選択ならピッカーの入力先切替（プレイ/FL）。
  const onHeroRowTap = useCallback(
    (row: RowKey) => {
      if (selectedActive && selectedPoolId !== null) {
        if (assign[selectedPoolId] === row) {
          setAssign((a) => removeKey(a, selectedPoolId))
          setSelectedPoolId(null)
          return
        }
        if (!rowHasSpace(row)) return // 満杯: 選択は維持して別の段を選ばせる
        setAssign((a) => ({ ...a, [selectedPoolId]: row }))
        setSelectedPoolId(null)
        return
      }
      if (mode !== 'vs') setTarget({ kind: 'hero', row })
    },
    [selectedActive, selectedPoolId, assign, rowHasSpace, mode],
  )

  // ---- コミット判定 ----
  // 初手は5枚すべてを段へ割当。ストリートは2枚を割当し、残る1枚が自動的に捨て札になる。
  const commitState = useMemo(() => {
    if (mode === 'fl' || pool.length === 0 || pool.length !== expectedDraw) {
      return { valid: false }
    }
    // 対戦モード: ポジションに従って手番を守る。
    // OOP の Hero は相手が同ラウンドに追いつくまで、IP の Hero は相手が次を置くまで待つ。
    if (mode === 'vs') {
      if (vsBusy || vsVillainHand) return { valid: false }
      const hr = roundOf(heroCount)
      const vr = roundOf(boardCount(villains[0]))
      if (vsHeroIsIP ? vr !== hr + 1 : vr !== hr) return { valid: false }
    }
    const rowAdd: Record<RowKey, number> = { top: 0, middle: 0, bottom: 0 }
    let assigned = 0
    for (const c of pool) {
      const d = assign[cardId(c)]
      if (!d) continue
      assigned++
      rowAdd[d]++
    }
    for (const r of ROWS) {
      if (hero[r].length + rowAdd[r] > ROW_CAP[r]) return { valid: false }
    }
    const need = heroCount === 0 ? pool.length : pool.length - 1
    return { valid: assigned === need }
  }, [mode, vsBusy, vsVillainHand, vsHeroIsIP, villains, pool, expectedDraw, assign, hero, heroCount])

  const commit = useCallback(() => {
    if (!commitState.valid) return
    pushHistory()
    const nb = cloneBoard(hero)
    const nd = [...heroDiscards]
    for (const c of pool) {
      const d = assign[cardId(c)]
      if (d) nb[d] = [...nb[d], c]
      else nd.push(c) // 未割当（ストリートのちょうど1枚）は捨て札
    }
    setHero(nb)
    setHeroDiscards(nd)
    setPool([])
    setAssign({})
    setSelectedPoolId(null)
    setSugg(null)
    setEv(null)
  }, [commitState.valid, pushHistory, hero, heroDiscards, pool, assign])

  const applySuggestion = useCallback(
    (s: SuggestionDTO) => {
      pushHistory()
      setHero({ top: parseCards(s.top), middle: parseCards(s.middle), bottom: parseCards(s.bottom) })
      if (s.discarded) setHeroDiscards((d) => [...d, ...parseCards(s.discarded!)])
      setPool([])
      setAssign({})
      setSelectedPoolId(null)
      setSugg(null)
      setEv(null)
    },
    [pushHistory],
  )

  // ---- 推奨手の自動計算 ----
  useEffect(() => {
    suggTask.current?.cancel()
    suggTask.current = null
    setSugg(null)
    setSuggBusy(false)
    setSuggError(null)
    setSuggProgress(0)

    if (mode !== 'play') return
    if (heroCount >= 13) return
    if (pool.length !== expectedDraw || expectedDraw === 0) return
    const openSlots = 13 - heroCount
    if (heroCount > 0 && openSlots < 2) return

    setSuggBusy(true)
    const iters = PRECISION_ITERS[precision]
    const task =
      heroCount === 0
        ? suggestInitialParallel(
            { cards: pool, dead, variantId, jokers: useJokers, iters: iters.initial },
            setSuggProgress,
          )
        : suggestStreetParallel(
            { board: hero, drawn: pool, dead, variantId, jokers: useJokers, iters: iters.street },
            setSuggProgress,
          )
    suggTask.current = task
    task.promise
      .then((suggestions) => {
        if (suggTask.current !== task) return
        setSugg(suggestions)
        setSuggBusy(false)
      })
      .catch((err) => {
        if (suggTask.current !== task) return
        setSuggBusy(false)
        if (!(err instanceof CanceledError)) {
          setSuggError(err instanceof Error ? err.message : String(err))
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, heroCodes, poolCodes, deadCodes, variantId, useJokers, precision])

  // 盤面・設定が変わったら EV はリセット
  useEffect(() => {
    setEv(null)
    evTask.current?.cancel()
    evTask.current = null
    setEvBusy(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroCodes, deadCodes, variantId, players, mode, useJokers, precision])

  const estimateEv = useCallback(() => {
    evTask.current?.cancel()
    setEvBusy(true)
    setEv(null)
    const task = estimateEvParallel({
      board: hero,
      dead,
      variantId,
      jokers: useJokers,
      opponents: players - 1,
      iters: PRECISION_ITERS[precision].ev,
    })
    evTask.current = task
    task.promise
      .then((res) => {
        if (evTask.current !== task) return
        setEv(res)
        setEvBusy(false)
      })
      .catch((err) => {
        if (evTask.current !== task) return
        setEvBusy(false)
        if (!(err instanceof CanceledError)) setEv(null)
      })
  }, [hero, dead, variantId, players, useJokers, precision])

  const solveFL = useCallback(() => {
    flTask.current?.cancel()
    setFlBusy(true)
    setFlResults(null)
    setFlError(null)
    setFlProgress(0)
    const task = solveFLParallel({ cards: pool, variantId, jokers: useJokers }, setFlProgress)
    flTask.current = task
    task.promise
      .then((results) => {
        if (flTask.current !== task) return
        setFlResults(results)
        setFlBusy(false)
      })
      .catch((err) => {
        if (flTask.current !== task) return
        setFlBusy(false)
        if (!(err instanceof CanceledError)) {
          setFlError(err instanceof Error ? err.message : String(err))
        }
      })
  }, [pool, variantId, useJokers])

  // ---- 対戦モード（vs ソルバー）----

  // 新しいハンドを配る。ポジション（先手/後手）はハンドごとに交代し、
  // 実際の配札はポジションに従って進行ドライバが行う。
  const dealVs = useCallback(() => {
    const deck = shuffle(makeDeck(useJokers))
    setHero(emptyBoard())
    setHeroDiscards([])
    setVillains([emptyBoard(), emptyBoard()])
    setPool([])
    setAssign({})
    setHistory([])
    setEv(null)
    setVsError(null)
    setVsScored(false)
    setSelectedPoolId(null)
    setVsVillainHand(null)
    setVsVillainDiscards([])
    setVsHeroIsIP((p) => !p)
    setVsDeck(deck)
    setTarget({ kind: 'pool' })
  }, [useJokers])

  // 対戦モードの進行ドライバ。ポジションに従って山札から手札を配る。
  // 先手（OOP）が各ラウンドを先に置き、後手（IP）は相手の同ラウンド完了を見てから置く。
  // Hero の手札は自分の前ラウンド確定後すぐ配る（相手の思考中に検討できる）が、
  // 確定は commitState の手番ゲートが守る。
  useEffect(() => {
    if (mode !== 'vs' || vsDeck.length === 0) return
    if (vsVillainHand) return // ソルバーの配置待ち
    const hr = roundOf(heroCount)
    const vr = roundOf(boardCount(villains[0]))
    if (pool.length === 0 && hr < 5) {
      const n = hr === 0 ? 5 : 3
      setPool(vsDeck.slice(0, n))
      setVsDeck(vsDeck.slice(n))
      return
    }
    // ソルバーの手番: Hero が IP なら先行（vr === hr）、Hero が OOP なら追走（hr === vr + 1）。
    if (vr < 5 && (vsHeroIsIP ? vr === hr : hr === vr + 1)) {
      const n = vr === 0 ? 5 : 3
      setVsVillainHand(vsDeck.slice(0, n))
      setVsDeck(vsDeck.slice(n))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, vsDeck, vsVillainHand, heroCount, villains, pool.length, vsHeroIsIP])

  // ソルバーの思考: 手札（vsVillainHand）があれば推奨エンジンで配置を決める。
  // ソルバーが知れるのは自分の盤面・手札・捨て札と、Hero の公開盤面のみ（Hero の捨て札は見ない）。
  useEffect(() => {
    if (mode !== 'vs' || !vsVillainHand) {
      setVsBusy(false)
      return
    }
    setVsBusy(true)
    const villainBoard = villains[0]
    const deadForVillain = [...boardCards(hero), ...vsVillainDiscards]
    const iters = PRECISION_ITERS[precision]
    const task =
      boardCount(villainBoard) === 0
        ? suggestInitialParallel(
            { cards: vsVillainHand, dead: deadForVillain, variantId, jokers: useJokers, iters: iters.initial },
          )
        : suggestStreetParallel(
            { board: villainBoard, drawn: vsVillainHand, dead: deadForVillain, variantId, jokers: useJokers, iters: iters.street },
          )
    vsTask.current = task
    task.promise
      .then((suggs) => {
        if (vsTask.current !== task) return
        setVsBusy(false)
        const top = suggs[0]
        if (!top) {
          setVsError('no arrangement')
          return
        }
        setVillains((vs) => [
          { top: parseCards(top.top), middle: parseCards(top.middle), bottom: parseCards(top.bottom) },
          vs[1],
        ])
        if (top.discarded) {
          const discarded = parseCards(top.discarded)
          setVsVillainDiscards((d) => [...d, ...discarded])
        }
        setVsVillainHand(null)
      })
      .catch((err) => {
        if (vsTask.current !== task) return
        setVsBusy(false)
        if (!(err instanceof CanceledError)) {
          setVsError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      if (vsTask.current === task) {
        task.cancel()
        vsTask.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, vsVillainHand])

  // 現在のルール構成（種類 × デッキ）の成績バケット。
  const vsConfig = vsConfigKey(variantId, useJokers)
  const vsStats = vsStatsAll[vsConfig] ?? emptyVsStats()
  const vsConfigLabel = `${t(lang, variantId === 'normal' ? 'variantNormal' : 'variantUltimate')} / ${t(lang, useJokers ? 'deck54' : 'deck52')}`

  const resetVsStats = useCallback(() => {
    setVsStatsAll((all) => {
      const next = { ...all }
      delete next[vsConfig]
      saveVsStatsByConfig(next)
      return next
    })
  }, [vsConfig])

  // ---- 完成時の評価 ----
  const variant = VARIANTS[variantId]
  const heroFinal = useMemo(() => {
    if (mode === 'fl' || heroCount !== 13) return null
    if (hero.top.length !== 3 || hero.middle.length !== 5 || hero.bottom.length !== 5) return null
    const evaluated = evaluateArrangement(hero)
    return {
      evaluated,
      royalties: royaltiesTotal(evaluated),
      flCards: fantasylandCards(evaluated, variant),
    }
  }, [mode, heroCount, hero, variant])

  const finalScores = useMemo(() => {
    if (!heroFinal) return null
    const complete = shownVillains.filter(
      (v) => v.top.length === 3 && v.middle.length === 5 && v.bottom.length === 5,
    )
    if (complete.length !== shownVillains.length || complete.length === 0) return null
    const evs = complete.map((v) => evaluateArrangement(v))
    const totals = scoreMultiEvaluated([heroFinal.evaluated, ...evs], variant)
    const pairwise = evs.map((v) => scoreEvaluated(heroFinal.evaluated, v, variant))
    return { total: totals[0], pairwise }
  }, [heroFinal, shownVillains, variant])

  // 対戦モードの結果（両者13枚完成時のみ）。
  const vsResult = useMemo(() => {
    if (mode !== 'vs' || !heroFinal) return null
    const v = villains[0]
    if (v.top.length !== 3 || v.middle.length !== 5 || v.bottom.length !== 5) return null
    const vEval = evaluateArrangement(v)
    return {
      score: scoreEvaluated(heroFinal.evaluated, vEval, variant),
      hero: {
        fouled: heroFinal.evaluated.fouled,
        royalties: heroFinal.evaluated.fouled ? 0 : heroFinal.royalties,
        fl: heroFinal.evaluated.fouled ? 0 : heroFinal.flCards,
      },
      villain: {
        fouled: vEval.fouled,
        royalties: vEval.fouled ? 0 : royaltiesTotal(vEval),
        fl: vEval.fouled ? 0 : fantasylandCards(vEval, variant),
      },
    }
  }, [mode, heroFinal, villains, variant])

  // ハンド完了時に通算成績へ一度だけ加算する（vsScored は永続化されリロードでも二重加算しない）。
  // 現在のルール構成（種類 × デッキ）のバケットに、全体 + ポジション別で積み上げる。
  useEffect(() => {
    if (!vsResult || vsScored) return
    setVsScored(true)
    setVsStatsAll((all) => {
      const s = all[vsConfig] ?? emptyVsStats()
      const win = vsResult.score > 0 ? 1 : 0
      const bump = (p: VsPosStats): VsPosStats => ({
        hands: p.hands + 1,
        wins: p.wins + win,
        total: p.total + vsResult.score,
      })
      const bucket: VsStats = {
        ...bump(s),
        oop: vsHeroIsIP ? s.oop : bump(s.oop),
        ip: vsHeroIsIP ? bump(s.ip) : s.ip,
      }
      const next = { ...all, [vsConfig]: bucket }
      saveVsStatsByConfig(next)
      return next
    })
  }, [vsResult, vsScored, vsHeroIsIP, vsConfig])

  // ---- 描画 ----
  const streetLabel =
    heroCount >= 13
      ? t(lang, 'handComplete')
      : heroCount === 0
        ? t(lang, 'streetInitial')
        : t(lang, 'streetN', { n: Math.min(5, Math.floor((heroCount - 5) / 2) + 2) })

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>{t(lang, 'title')}</h1>
          <p className="subtitle">{t(lang, 'subtitle')}</p>
        </div>
        <button type="button" className="lang-toggle" onClick={() => setLang((l) => (l === 'ja' ? 'en' : 'ja'))}>
          {lang === 'ja' ? 'EN' : 'JA'}
        </button>
      </header>

      <div className="controls">
        <label className="ctrl-select">
          {t(lang, 'variant')}
          <select value={variantId} onChange={(e) => setVariantId(e.target.value as VariantId)}>
            <option value="normal">{t(lang, 'variantNormal')}</option>
            <option value="ultimate">{t(lang, 'variantUltimate')}</option>
          </select>
        </label>
        <label className="ctrl-select">
          {t(lang, 'deck')}
          <select
            value={useJokers ? '54' : '52'}
            onChange={(e) => setUseJokers(e.target.value === '54')}
          >
            <option value="52">{t(lang, 'deck52')}</option>
            <option value="54">{t(lang, 'deck54')}</option>
          </select>
        </label>
        <label className="ctrl-select">
          {t(lang, 'players')}
          <select value={players} onChange={(e) => setPlayers(Number(e.target.value) as 2 | 3)}>
            <option value={2}>{t(lang, 'playersHU')}</option>
            <option value={3}>{t(lang, 'players3')}</option>
          </select>
        </label>
        <label className="ctrl-select">
          {t(lang, 'precision')}
          <select value={precision} onChange={(e) => setPrecision(e.target.value as Precision)}>
            <option value="fast">{t(lang, 'precisionFast')}</option>
            <option value="standard">{t(lang, 'precisionStandard')}</option>
            <option value="high">{t(lang, 'precisionHigh')}</option>
          </select>
        </label>
        <div className="mode-toggle" role="group">
          <button
            type="button"
            className={mode === 'play' ? 'on' : ''}
            onClick={() => setMode('play')}
          >
            {t(lang, 'modePlay')}
          </button>
          <button type="button" className={mode === 'vs' ? 'on' : ''} onClick={() => setMode('vs')}>
            {t(lang, 'modeVs')}
          </button>
          <button type="button" className={mode === 'fl' ? 'on' : ''} onClick={() => setMode('fl')}>
            {t(lang, 'modeFL')}
          </button>
        </div>
        <div className="spacer" />
        <button
          type="button"
          className="ghost-btn"
          onClick={undo}
          disabled={history.length === 0 || mode === 'vs'}
        >
          {t(lang, 'undo')}
        </button>
        <button type="button" className="ghost-btn" onClick={resetAll}>
          {t(lang, 'reset')}
        </button>
      </div>

      {mode === 'vs' && !vsHandActive && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">{t(lang, 'modeVs')}</span>
          </div>
          <p className="hint">{t(lang, 'vsIntro')}</p>
          <button type="button" className="primary-btn" onClick={dealVs}>
            {t(lang, 'vsDeal')}
          </button>
          <VsStatsView lang={lang} stats={vsStats} configLabel={vsConfigLabel} />
          {vsStats.hands > 0 && (
            <button type="button" className="ghost-btn vs-stats-reset" onClick={resetVsStats}>
              {t(lang, 'vsResetStats')}
            </button>
          )}
        </section>
      )}

      {(mode === 'play' || vsHandActive) && (
        <section className="panel hero-panel">
          <div className="panel-head">
            <span className="panel-title">{t(lang, 'hero')}</span>
            {mode === 'vs' && (
              <span className={`pos-badge ${vsHeroIsIP ? 'ip' : ''}`}>
                {t(lang, vsHeroIsIP ? 'vsPosIP' : 'vsPosOOP')}
              </span>
            )}
            <span className="street-label">{streetLabel}</span>
            {heroFinal && (
              <span className={`final-chips ${heroFinal.evaluated.fouled ? 'foul' : ''}`}>
                {heroFinal.evaluated.fouled
                  ? t(lang, 'fouled')
                  : `${t(lang, 'royalties')} ${heroFinal.royalties} / ${
                      heroFinal.flCards > 0
                        ? `FL ${t(lang, 'flCards', { n: heroFinal.flCards })}`
                        : `FL ${t(lang, 'flNone')}`
                    }`}
              </span>
            )}
          </div>
          {ROWS.map((row) => (
            <BoardRow
              key={row}
              lang={lang}
              row={row}
              cards={hero[row]}
              active={mode !== 'vs' && target.kind === 'hero' && target.row === row}
              selectable={mode !== 'vs' || selectedActive}
              droppable={selectedActive && rowHasSpace(row)}
              onSelect={() => onHeroRowTap(row)}
              onRemove={(c) => onPickerToggle(c)}
            />
          ))}
          {heroDiscards.length > 0 && (
            <div className="discard-line">
              <span className="row-label">{t(lang, 'discards')}</span>
              <span className="row-cards">
                {heroDiscards.map((c) => (
                  <CardGlyph key={cardId(c)} card={c} size="sm" />
                ))}
              </span>
            </div>
          )}
        </section>
      )}

      {(mode === 'play' || vsHandActive) && heroCount < 13 && (
        <section
          className={`panel pool-panel selectable ${target.kind === 'pool' ? 'active' : ''}`}
          onClick={() => setTarget({ kind: 'pool' })}
        >
          <div className="panel-head" role="button" tabIndex={0}>
            <span className="panel-title">{t(lang, 'pool')}</span>
            <span className="street-label">
              {pool.length}/{expectedDraw}
            </span>
          </div>
          <p className="hint pool-hint">
            {pool.length < expectedDraw
              ? t(lang, 'drawPrompt', { n: expectedDraw - pool.length })
              : t(
                  lang,
                  mode === 'vs'
                    ? heroCount === 0
                      ? 'vsAssignHintInitial'
                      : 'vsAssignHintStreet'
                    : heroCount === 0
                      ? 'assignHintInitial'
                      : 'assignHintStreet',
                )}
          </p>
          {/* ドロー枚数分の固定グリッド。割当バッジのスペースを常に確保し、
              選択前後でレイアウトを変えない。カードのタップ = 選択中の段へ割当。 */}
          <div
            className="pool-cards"
            style={{ gridTemplateColumns: `repeat(${expectedDraw}, minmax(0, 1fr))` }}
          >
            {pool.map((c) => {
              const id = cardId(c)
              const dest = assign[id]
              const drawComplete = pool.length === expectedDraw
              // ストリートで未割当が残り1枚になったら、そのカードは自動的に捨て札。
              const autoDiscard =
                drawComplete &&
                heroCount > 0 &&
                !dest &&
                pool.filter((p) => !assign[cardId(p)]).length === 1
              return (
                <div className="pool-card" key={id}>
                  <button
                    type="button"
                    className={`pool-card-btn ${selectedPoolId === id ? 'sel' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onPoolCardTap(c)
                    }}
                  >
                    <CardGlyph card={c} />
                  </button>
                  <span
                    className={`dest-badge ${autoDiscard ? 'discard' : dest ? `dest-${dest}` : ''}`}
                    style={{ visibility: dest || autoDiscard ? 'visible' : 'hidden' }}
                  >
                    {autoDiscard
                      ? t(lang, 'discardLabel').slice(0, 1)
                      : t(lang, (dest ?? 'top') as MessageKey).slice(0, 1)}
                  </span>
                </div>
              )
            })}
          </div>
          <button type="button" className="primary-btn" disabled={!commitState.valid} onClick={commit}>
            {mode === 'vs' && (vsBusy || vsVillainHand)
              ? t(lang, 'vsWaitingVillain')
              : t(lang, 'commit')}
          </button>
        </section>
      )}

      {mode === 'vs' && vsResult && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">
              {vsResult.score > 0
                ? t(lang, 'vsResultWin')
                : vsResult.score < 0
                  ? t(lang, 'vsResultLose')
                  : t(lang, 'vsResultTie')}
            </span>
            <span className={`pos-badge ${vsHeroIsIP ? 'ip' : ''}`}>
              {t(lang, vsHeroIsIP ? 'vsPosIP' : 'vsPosOOP')}
            </span>
            <span className="street-label">
              {t(lang, 'vsScore')} <SignedNumber value={vsResult.score} />
            </span>
          </div>
          <div className="final-scores">
            {(
              [
                [t(lang, 'vsYou'), vsResult.hero],
                [t(lang, 'solverName'), vsResult.villain],
              ] as const
            ).map(([name, side]) => (
              <span key={name}>
                {name}:{' '}
                {side.fouled
                  ? t(lang, 'fouled')
                  : `${t(lang, 'royalties')} ${side.royalties} / FL ${
                      side.fl > 0 ? t(lang, 'flCards', { n: side.fl }) : t(lang, 'flNone')
                    }`}
              </span>
            ))}
          </div>
          <button type="button" className="primary-btn" onClick={dealVs}>
            {t(lang, 'vsNextHand')}
          </button>
          <VsStatsView lang={lang} stats={vsStats} configLabel={vsConfigLabel} />
          <p className="ev-hint">{t(lang, 'vsRules')}</p>
        </section>
      )}

      {mode === 'play' && (suggBusy || sugg || suggError) && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">{t(lang, 'suggestions')}</span>
          </div>
          {suggBusy && (
            <div className="progress-line">
              <span>{t(lang, 'computing', { pct: Math.round(suggProgress * 100) })}</span>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${Math.round(suggProgress * 100)}%` }} />
              </div>
            </div>
          )}
          {suggError && <p className="hint error">{t(lang, 'errorPrefix', { msg: suggError })}</p>}
          {sugg && sugg.length === 0 && <p className="hint error">{t(lang, 'noValid')}</p>}
          {sugg &&
            sugg.map((s, i) => (
              <SuggestionView
                key={i}
                lang={lang}
                index={i}
                suggestion={s}
                hero={hero}
                onApply={() => applySuggestion(s)}
              />
            ))}
          {sugg && sugg.length > 0 && <p className="ev-hint">{t(lang, 'suggestHint')}</p>}
        </section>
      )}

      {mode === 'play' && heroFinal && (
        <section className="panel">
          <dl className="stats">
            <div>
              <dt>{t(lang, 'royalties')}</dt>
              <dd>{heroFinal.evaluated.fouled ? 0 : heroFinal.royalties}</dd>
            </div>
            <div>
              <dt>{t(lang, 'fantasyland')}</dt>
              <dd>{heroFinal.flCards > 0 ? t(lang, 'flCards', { n: heroFinal.flCards }) : t(lang, 'flNone')}</dd>
            </div>
            <div>
              <dt>{t(lang, 'ev')}</dt>
              <dd>
                {ev !== null ? (
                  <>
                    <SignedNumber value={ev.mean} />
                    {ev.ci95 > 0 && <span className="ev-ci"> ±{ev.ci95.toFixed(1)}</span>}
                  </>
                ) : evBusy ? (
                  t(lang, 'estimatingEv')
                ) : (
                  <button type="button" className="ev-btn" onClick={estimateEv}>
                    {t(lang, 'estimateEv')}
                  </button>
                )}
              </dd>
            </div>
          </dl>
          <p className="ev-hint">{t(lang, 'evHint', { n: players - 1 })}</p>
          {finalScores && (
            <div className="final-scores">
              <span className="panel-title">{t(lang, 'actualScore')}:</span>
              {finalScores.pairwise.map((s, i) => (
                <span key={i}>
                  {t(lang, 'vsVillainN', { n: i + 1 })} <SignedNumber value={s} />
                </span>
              ))}
              {finalScores.pairwise.length > 1 && (
                <span>
                  {t(lang, 'totalScore')} <SignedNumber value={finalScores.total} />
                </span>
              )}
            </div>
          )}
        </section>
      )}

      {mode === 'fl' && (
        <section
          className={`panel pool-panel selectable ${target.kind === 'pool' ? 'active' : ''}`}
          onClick={() => setTarget({ kind: 'pool' })}
        >
          <div className="panel-head" role="button" tabIndex={0}>
            <span className="panel-title">{t(lang, 'poolFL')}</span>
            <span className="street-label">{pool.length}/13–17</span>
          </div>
          <p className="hint">{t(lang, 'flPoolPrompt')}</p>
          {pool.length > 0 && (
            <div className="pool-cards wrap">
              {pool.map((c) => (
                <button
                  type="button"
                  className="pool-card-btn"
                  key={cardId(c)}
                  onClick={() => onPickerToggle(c)}
                >
                  <CardGlyph card={c} />
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="primary-btn"
            disabled={pool.length < 13 || pool.length > 17 || flBusy}
            onClick={solveFL}
          >
            {flBusy ? t(lang, 'flSolving') : t(lang, 'flSolve')}
          </button>
          {flBusy && (
            <div className="progress-line">
              <span>{t(lang, 'computing', { pct: Math.round(flProgress * 100) })}</span>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.round(flProgress * 100)}%` }}
                />
              </div>
            </div>
          )}
          {flError && <p className="hint error">{t(lang, 'errorPrefix', { msg: flError })}</p>}
        </section>
      )}

      {mode === 'fl' && flResults && (
        <section className="panel">
          {flResults.length === 0 && <p className="hint error">{t(lang, 'noValid')}</p>}
          {flResults.map((r, i) => (
            <div className="fl-result" key={i}>
              <div className="panel-head">
                <span className="panel-title">{t(lang, 'flBest', { n: i + 1 })}</span>
                <span className={`stay-badge ${r.stays ? 'yes' : ''}`}>
                  {r.stays ? t(lang, 'stay') : t(lang, 'stayNo')}
                </span>
                <span className="street-label">
                  {t(lang, 'royalties')} {r.royalties}
                </span>
              </div>
              <ResultRows lang={lang} top={parseCards(r.top)} middle={parseCards(r.middle)} bottom={parseCards(r.bottom)} />
            </div>
          ))}
          {flResults.length > 0 && (
            <p className="ev-hint">
              {t(lang, 'flHint', {
                bonus: useJokers ? DEFAULT_STAY_BONUS_JOKER : DEFAULT_STAY_BONUS,
              })}
            </p>
          )}
        </section>
      )}

      {mode === 'vs'
        ? vsHandActive && (
            <section className="panel villain-panel">
              <div className="panel-head">
                <span className="panel-title">{t(lang, 'solverName')}</span>
                {vsBusy && <span className="street-label">{t(lang, 'vsThinking')}</span>}
                <span className="street-label">{boardCount(villains[0])}/13</span>
              </div>
              <ResultRows
                lang={lang}
                top={villains[0].top}
                middle={villains[0].middle}
                bottom={villains[0].bottom}
              />
              {vsError && <p className="hint error">{t(lang, 'errorPrefix', { msg: vsError })}</p>}
            </section>
          )
        : shownVillains.map((v, idx) => (
            <section className="panel villain-panel" key={idx}>
              <div className="panel-head">
                <span className="panel-title">{t(lang, 'villainN', { n: idx + 1 })}</span>
                <span className="street-label">{boardCount(v)}/13</span>
              </div>
              {ROWS.map((row) => (
                <BoardRow
                  key={row}
                  lang={lang}
                  row={row}
                  cards={v[row]}
                  active={target.kind === 'villain' && target.idx === idx && target.row === row}
                  onSelect={() => setTarget({ kind: 'villain', idx, row })}
                  onRemove={(c) => onPickerToggle(c)}
                  compact
                />
              ))}
            </section>
          ))}

      {mode !== 'vs' && <p className="hint">{t(lang, 'targetHint')}</p>}
      {mode !== 'vs' && (
        <CardPicker selected={usedIds} canAdd={canAdd} onToggle={onPickerToggle} jokers={useJokers} />
      )}
    </main>
  )
}

// ---- 小物コンポーネント --------------------------------------------------------

function removeKey(a: Record<number, RowKey>, id: number): Record<number, RowKey> {
  const na = { ...a }
  delete na[id]
  return na
}

function rowHandText(lang: Lang, row: RowKey, cards: Card[]): string {
  const full = row === 'top' ? 3 : 5
  if (cards.length !== full) return `${cards.length}/${full}`
  return handLabel(row === 'top' ? evaluate3(cards) : evaluate5(cards), lang)
}

function BoardRow({
  lang,
  row,
  cards,
  active,
  onSelect,
  onRemove,
  compact,
  selectable = true,
  droppable = false,
}: {
  lang: Lang
  row: RowKey
  cards: Card[]
  active: boolean
  onSelect: () => void
  onRemove: (card: Card) => void
  compact?: boolean
  /** false で選択先の切替を無効化（対戦モードの Hero 行など）。 */
  selectable?: boolean
  /** 選択中のプールカードを置ける段（ハイライト表示）。 */
  droppable?: boolean
}) {
  const clickable = selectable || droppable
  return (
    // 行全体をタップで選択先にできるようにする（カード自体のタップは取り除き操作を優先）。
    <div
      className={`board-row ${clickable ? 'selectable' : ''} ${active ? 'active' : ''} ${droppable ? 'droppable' : ''} ${compact ? 'compact' : ''}`}
      onClick={clickable ? onSelect : undefined}
    >
      <button
        type="button"
        className="board-row-target"
        onClick={clickable ? onSelect : undefined}
      >
        <span className="row-label">{t(lang, row as MessageKey)}</span>
        <span className="row-hand">{rowHandText(lang, row, cards)}</span>
      </button>
      <div className="row-cards">
        {cards.map((c) => (
          <button
            type="button"
            key={cardId(c)}
            className="row-card-btn"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(c)
            }}
          >
            <CardGlyph card={c} size={compact ? 'sm' : 'md'} />
          </button>
        ))}
      </div>
    </div>
  )
}

function ResultRows({ lang, top, middle, bottom }: { lang: Lang; top: Card[]; middle: Card[]; bottom: Card[] }) {
  return (
    <>
      {(
        [
          ['top', top],
          ['middle', middle],
          ['bottom', bottom],
        ] as const
      ).map(([row, cards]) => (
        <div className="board-row readonly" key={row}>
          <div className="board-row-target">
            <span className="row-label">{t(lang, row as MessageKey)}</span>
            <span className="row-hand">{rowHandText(lang, row, cards as Card[])}</span>
          </div>
          <div className="row-cards">
            {(cards as Card[]).map((c) => (
              <CardGlyph key={cardId(c)} card={c} size="sm" />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

function SuggestionView({
  lang,
  index,
  suggestion,
  hero,
  onApply,
}: {
  lang: Lang
  index: number
  suggestion: SuggestionDTO
  hero: PB
  onApply: () => void
}) {
  // 現在の盤面との差分（新しく置くカード）を強調表示する。
  const heroIds = useMemo(() => new Set(boardCards(hero).map(cardId)), [hero])
  const rows = (
    [
      ['top', suggestion.top],
      ['middle', suggestion.middle],
      ['bottom', suggestion.bottom],
    ] as const
  ).map(([row, codes]) => {
    const cards = parseCards(codes)
    const added = cards.filter((c) => !heroIds.has(cardId(c)))
    return { row, added }
  })
  return (
    <div className="suggestion">
      <div className="sugg-main">
        <div className="sugg-placements">
          <span className="sugg-rank">#{index + 1}</span>
          {rows.map(
            ({ row, added }) =>
              added.length > 0 && (
                <span className="sugg-place" key={row}>
                  <span className="row-label">{t(lang, row as MessageKey)}</span>
                  {added.map((c) => (
                    <CardGlyph key={cardId(c)} card={c} size="sm" />
                  ))}
                </span>
              ),
          )}
          {suggestion.discarded && (
            <span className="sugg-place discard">
              <span className="row-label">{t(lang, 'discardLabel')}</span>
              <CardGlyph card={parseCards(suggestion.discarded)[0]} size="sm" />
            </span>
          )}
        </div>
        <button type="button" className="apply-btn" onClick={onApply}>
          {t(lang, 'apply')}
        </button>
      </div>
      <div className="sugg-metrics">
        <span>
          {t(lang, 'suggScore')} <strong>{suggestion.score.toFixed(1)}</strong>
        </span>
        <span>
          {t(lang, 'expRoyalty')} {suggestion.expRoyalty.toFixed(1)}
        </span>
        <span>
          {t(lang, 'flChance')} {(suggestion.flProb * 100).toFixed(0)}%
        </span>
        <span className={suggestion.foulProb > 0.25 ? 'neg' : ''}>
          {t(lang, 'foulRisk')} {(suggestion.foulProb * 100).toFixed(0)}%
        </span>
      </div>
    </div>
  )
}

function vsStatsText(lang: Lang, s: VsPosStats): string {
  return t(lang, 'vsStatsBody', {
    hands: s.hands,
    wr: s.hands > 0 ? Math.round((s.wins / s.hands) * 100) : 0,
    total: `${s.total >= 0 ? '+' : ''}${s.total}`,
  })
}

/** 対戦モードの通算成績（現在のルール構成の全体 + ポジション別の内訳）。 */
function VsStatsView({
  lang,
  stats,
  configLabel,
}: {
  lang: Lang
  stats: VsStats
  configLabel: string
}) {
  if (stats.hands === 0) return null
  return (
    <div className="vs-stats">
      <span>
        <strong>
          {t(lang, 'vsStatsTotalLabel')}（{configLabel}）
        </strong>{' '}
        {vsStatsText(lang, stats)}
      </span>
      {stats.oop.hands > 0 && (
        <span>
          {t(lang, 'vsPosOOP')} {vsStatsText(lang, stats.oop)}
        </span>
      )}
      {stats.ip.hands > 0 && (
        <span>
          {t(lang, 'vsPosIP')} {vsStatsText(lang, stats.ip)}
        </span>
      )}
    </div>
  )
}

function SignedNumber({ value }: { value: number }) {
  return (
    <span className={value >= 0 ? 'pos' : 'neg'}>
      {value >= 0 ? '+' : ''}
      {Number.isInteger(value) ? value : value.toFixed(2)}
    </span>
  )
}

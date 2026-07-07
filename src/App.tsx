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
  parseCards,
  royaltiesTotal,
  scoreEvaluated,
  scoreMultiEvaluated,
} from './domain'
import { type Lang, type MessageKey, t } from './i18n'
import { CardGlyph } from './ui/CardGlyph'
import { CardPicker } from './ui/CardPicker'
import { handLabel } from './ui/handLabel'
import { evaluate3, evaluate5 } from './domain'
import type {
  FLResultDTO,
  SuggestionDTO,
  WorkerRequest,
  WorkerResponse,
} from './worker/solver.worker'

// ---- 型・ヘルパー -------------------------------------------------------------

interface PB {
  top: Card[]
  middle: Card[]
  bottom: Card[]
}

type Dest = RowKey | 'discard'
type Mode = 'play' | 'fl'

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
  assign: Record<number, Dest>
}

function newWorker(): Worker {
  return new Worker(new URL('./worker/solver.worker.ts', import.meta.url), { type: 'module' })
}

// ---- 本体 ---------------------------------------------------------------------

export default function App() {
  const [lang, setLang] = useState<Lang>('ja')
  const [variantId, setVariantId] = useState<VariantId>('normal')
  const [players, setPlayersState] = useState<2 | 3>(2)
  const [mode, setModeState] = useState<Mode>('play')
  const [useJokers, setUseJokersState] = useState(false)

  const [hero, setHero] = useState<PB>(emptyBoard)
  const [heroDiscards, setHeroDiscards] = useState<Card[]>([])
  const [villains, setVillains] = useState<[PB, PB]>([emptyBoard(), emptyBoard()])
  const [pool, setPool] = useState<Card[]>([])
  const [assign, setAssign] = useState<Record<number, Dest>>({})
  const [target, setTarget] = useState<Target>({ kind: 'pool' })
  const [history, setHistory] = useState<Snapshot[]>([])

  const [sugg, setSugg] = useState<SuggestionDTO[] | null>(null)
  const [suggBusy, setSuggBusy] = useState(false)
  const [suggProgress, setSuggProgress] = useState(0)
  const [suggError, setSuggError] = useState<string | null>(null)

  const [flResults, setFlResults] = useState<FLResultDTO[] | null>(null)
  const [flBusy, setFlBusy] = useState(false)
  const [flError, setFlError] = useState<string | null>(null)

  const [ev, setEv] = useState<number | null>(null)
  const [evBusy, setEvBusy] = useState(false)

  const suggWorker = useRef<Worker | null>(null)
  const flWorker = useRef<Worker | null>(null)
  const evWorker = useRef<Worker | null>(null)
  const reqId = useRef(0)

  useEffect(() => {
    return () => {
      suggWorker.current?.terminate()
      flWorker.current?.terminate()
      evWorker.current?.terminate()
    }
  }, [])

  // ---- 派生値 ----
  const shownVillains = useMemo(
    () => villains.slice(0, players - 1) as PB[],
    [villains, players],
  )
  const heroCount = boardCount(hero)
  const expectedDraw = mode === 'play' ? (heroCount === 0 ? 5 : heroCount >= 13 ? 0 : 3) : FL_MAX

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

  // ---- 入力操作 ----
  const setPlayers = useCallback((n: 2 | 3) => {
    setPlayersState(n)
    if (n === 2) setVillains((v) => [v[0], emptyBoard()])
    setTarget({ kind: 'pool' })
  }, [])

  const setMode = useCallback((m: Mode) => {
    setModeState(m)
    setPool([])
    setAssign({})
    setSugg(null)
    setFlResults(null)
    setFlError(null)
    setEv(null)
    setTarget({ kind: 'pool' })
  }, [])

  const resetAll = useCallback(() => {
    setHero(emptyBoard())
    setHeroDiscards([])
    setVillains([emptyBoard(), emptyBoard()])
    setPool([])
    setAssign({})
    setHistory([])
    setSugg(null)
    setFlResults(null)
    setEv(null)
    setTarget({ kind: 'pool' })
  }, [])

  // デッキ切替（ジョーカー有無）は盤面のカードと整合しなくなるため全リセットする。
  const setUseJokers = useCallback(
    (on: boolean) => {
      setUseJokersState(on)
      resetAll()
    },
    [resetAll],
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
      const id = cardId(card)
      if (usedIds.has(id)) {
        // どこにあっても取り除く
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
    [usedIds, canAdd, target],
  )

  const setDest = useCallback((id: number, dest: Dest) => {
    setAssign((a) => (a[id] === dest ? removeKey(a, id) : { ...a, [id]: dest }))
  }, [])

  // ---- コミット判定 ----
  const commitState = useMemo(() => {
    if (mode !== 'play' || pool.length === 0 || pool.length !== expectedDraw) {
      return { valid: false }
    }
    const rowAdd: Record<RowKey, number> = { top: 0, middle: 0, bottom: 0 }
    let discards = 0
    let assigned = 0
    for (const c of pool) {
      const d = assign[cardId(c)]
      if (!d) continue
      assigned++
      if (d === 'discard') discards++
      else rowAdd[d]++
    }
    if (assigned !== pool.length) return { valid: false }
    for (const r of ROWS) {
      if (hero[r].length + rowAdd[r] > ROW_CAP[r]) return { valid: false }
    }
    if (heroCount === 0) {
      if (discards !== 0) return { valid: false }
    } else if (discards !== 1) {
      return { valid: false }
    }
    return { valid: true }
  }, [mode, pool, expectedDraw, assign, hero, heroCount])

  const commit = useCallback(() => {
    if (!commitState.valid) return
    pushHistory()
    const nb = cloneBoard(hero)
    const nd = [...heroDiscards]
    for (const c of pool) {
      const d = assign[cardId(c)]
      if (d === 'discard') nd.push(c)
      else if (d) nb[d] = [...nb[d], c]
    }
    setHero(nb)
    setHeroDiscards(nd)
    setPool([])
    setAssign({})
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
      setSugg(null)
      setEv(null)
    },
    [pushHistory],
  )

  // ---- 推奨手の自動計算 ----
  useEffect(() => {
    suggWorker.current?.terminate()
    suggWorker.current = null
    setSugg(null)
    setSuggBusy(false)
    setSuggError(null)
    setSuggProgress(0)

    if (mode !== 'play') return
    if (heroCount >= 13) return
    if (pool.length !== expectedDraw || expectedDraw === 0) return
    const openSlots = 13 - heroCount
    if (heroCount > 0 && openSlots < 2) return

    const id = ++reqId.current
    const worker = newWorker()
    suggWorker.current = worker
    setSuggBusy(true)

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.id !== reqId.current) return
      if (msg.kind === 'progress') {
        setSuggProgress(msg.total > 0 ? msg.done / msg.total : 0)
        return
      }
      setSuggBusy(false)
      if (msg.kind === 'suggestions') setSugg(msg.suggestions)
      else if (msg.kind === 'error') setSuggError(msg.message)
    }

    const req: WorkerRequest =
      heroCount === 0
        ? {
            id,
            kind: 'suggestInitial',
            cards: pool.map(cardToString),
            dead: dead.map(cardToString),
            variantId,
            jokers: useJokers,
          }
        : {
            id,
            kind: 'suggestStreet',
            board: { top: hero.top.map(cardToString), middle: hero.middle.map(cardToString), bottom: hero.bottom.map(cardToString) },
            drawn: pool.map(cardToString),
            dead: dead.map(cardToString),
            variantId,
            jokers: useJokers,
          }
    worker.postMessage(req)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, heroCodes, poolCodes, deadCodes, variantId, useJokers])

  // 盤面・設定が変わったら EV はリセット
  useEffect(() => {
    setEv(null)
    evWorker.current?.terminate()
    evWorker.current = null
    setEvBusy(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroCodes, deadCodes, variantId, players, mode, useJokers])

  const estimateEv = useCallback(() => {
    evWorker.current?.terminate()
    const worker = newWorker()
    evWorker.current = worker
    setEvBusy(true)
    setEv(null)
    const id = ++reqId.current
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.id !== id) return
      if (msg.kind === 'ev') setEv(msg.ev)
      setEvBusy(false)
      worker.terminate()
      if (evWorker.current === worker) evWorker.current = null
    }
    const req: WorkerRequest = {
      id,
      kind: 'ev',
      board: { top: hero.top.map(cardToString), middle: hero.middle.map(cardToString), bottom: hero.bottom.map(cardToString) },
      dead: dead.map(cardToString),
      variantId,
      iters: 200,
      opponents: players - 1,
      jokers: useJokers,
    }
    worker.postMessage(req)
  }, [hero, dead, variantId, players, useJokers])

  const solveFL = useCallback(() => {
    flWorker.current?.terminate()
    const worker = newWorker()
    flWorker.current = worker
    setFlBusy(true)
    setFlResults(null)
    setFlError(null)
    const id = ++reqId.current
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.id !== id) return
      setFlBusy(false)
      if (msg.kind === 'fl') setFlResults(msg.results)
      else if (msg.kind === 'error') setFlError(msg.message)
      worker.terminate()
      if (flWorker.current === worker) flWorker.current = null
    }
    const req: WorkerRequest = {
      id,
      kind: 'solveFL',
      cards: pool.map(cardToString),
      variantId,
      jokers: useJokers,
    }
    worker.postMessage(req)
  }, [pool, variantId, useJokers])

  // ---- 完成時の評価 ----
  const variant = VARIANTS[variantId]
  const heroFinal = useMemo(() => {
    if (mode !== 'play' || heroCount !== 13) return null
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
        <div className="mode-toggle" role="group">
          <button
            type="button"
            className={mode === 'play' ? 'on' : ''}
            onClick={() => setMode('play')}
          >
            {t(lang, 'modePlay')}
          </button>
          <button type="button" className={mode === 'fl' ? 'on' : ''} onClick={() => setMode('fl')}>
            {t(lang, 'modeFL')}
          </button>
        </div>
        <div className="spacer" />
        <button type="button" className="ghost-btn" onClick={undo} disabled={history.length === 0}>
          {t(lang, 'undo')}
        </button>
        <button type="button" className="ghost-btn" onClick={resetAll}>
          {t(lang, 'reset')}
        </button>
      </div>

      {mode === 'play' && (
        <section className="panel hero-panel">
          <div className="panel-head">
            <span className="panel-title">{t(lang, 'hero')}</span>
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
              active={target.kind === 'hero' && target.row === row}
              onSelect={() => setTarget({ kind: 'hero', row })}
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

      {mode === 'play' && heroCount < 13 && (
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
              : t(lang, heroCount === 0 ? 'assignHintInitial' : 'assignHintStreet')}
          </p>
          {/* ドロー枚数分の固定グリッド。置き先ボタンは全カード選択後まで
              visibility:hidden でスペースだけ確保し、選択前後でレイアウトを変えない。 */}
          <div
            className="pool-cards"
            style={{ gridTemplateColumns: `repeat(${expectedDraw}, minmax(0, 1fr))` }}
          >
            {pool.map((c) => {
              const id = cardId(c)
              const dest = assign[id]
              const showDest = pool.length === expectedDraw
              return (
                <div className="pool-card" key={id}>
                  <button type="button" className="pool-card-btn" onClick={() => onPickerToggle(c)}>
                    <CardGlyph card={c} />
                  </button>
                  <div className="dest-btns" style={{ visibility: showDest ? 'visible' : 'hidden' }}>
                    {ROWS.map((r) => (
                      <button
                        type="button"
                        key={r}
                        className={dest === r ? 'on' : ''}
                        disabled={!showDest}
                        onClick={() => setDest(id, r)}
                      >
                        {t(lang, r as MessageKey).slice(0, 1)}
                      </button>
                    ))}
                    {heroCount > 0 && (
                      <button
                        type="button"
                        className={`dest-discard ${dest === 'discard' ? 'on' : ''}`}
                        disabled={!showDest}
                        onClick={() => setDest(id, 'discard')}
                      >
                        {t(lang, 'discardLabel').slice(0, 1)}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <button type="button" className="primary-btn" disabled={!commitState.valid} onClick={commit}>
            {t(lang, 'commit')}
          </button>
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
                  <SignedNumber value={ev} />
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
            <div className="pool-cards">
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

      {shownVillains.map((v, idx) => (
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

      <p className="hint">{t(lang, 'targetHint')}</p>
      <CardPicker selected={usedIds} canAdd={canAdd} onToggle={onPickerToggle} jokers={useJokers} />
    </main>
  )
}

// ---- 小物コンポーネント --------------------------------------------------------

function removeKey(a: Record<number, Dest>, id: number): Record<number, Dest> {
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
}: {
  lang: Lang
  row: RowKey
  cards: Card[]
  active: boolean
  onSelect: () => void
  onRemove: (card: Card) => void
  compact?: boolean
}) {
  return (
    // 行全体をタップで選択先にできるようにする（カード自体のタップは取り除き操作を優先）。
    <div
      className={`board-row selectable ${active ? 'active' : ''} ${compact ? 'compact' : ''}`}
      onClick={onSelect}
    >
      <button type="button" className="board-row-target" onClick={onSelect}>
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

function SignedNumber({ value }: { value: number }) {
  return (
    <span className={value >= 0 ? 'pos' : 'neg'}>
      {value >= 0 ? '+' : ''}
      {Number.isInteger(value) ? value : value.toFixed(2)}
    </span>
  )
}

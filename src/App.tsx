import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Card,
  type VariantId,
  cardId,
  cardToString,
  evaluate3,
  evaluate5,
  parseCards,
} from './domain'
import { type Lang, t } from './i18n'
import { CardPicker } from './ui/CardPicker'
import { CardGlyph } from './ui/CardGlyph'
import { handLabel } from './ui/handLabel'
import type { WorkerRequest, WorkerResponse } from './worker/solver.worker'

const HAND_SIZE = 13
const EV_ITERS = 20

interface Result {
  top: Card[]
  middle: Card[]
  bottom: Card[]
  royalties: number
  flCards: number
}

function newWorker(): Worker {
  return new Worker(new URL('./worker/solver.worker.ts', import.meta.url), { type: 'module' })
}

export default function App() {
  const [lang, setLang] = useState<Lang>('ja')
  const [variantId, setVariantId] = useState<VariantId>('normal')
  const [selected, setSelected] = useState<Card[]>([])

  const [result, setResult] = useState<Result | null>(null)
  const [solving, setSolving] = useState(false)
  const [noValid, setNoValid] = useState(false)

  const [ev, setEv] = useState<number | null>(null)
  const [evRunning, setEvRunning] = useState(false)

  const solveWorker = useRef<Worker | null>(null)
  const evWorker = useRef<Worker | null>(null)
  const reqId = useRef(0)

  const selectedIds = useMemo(() => new Set(selected.map(cardId)), [selected])
  const codes = useMemo(() => selected.map(cardToString).join(','), [selected])

  const toggle = useCallback((card: Card) => {
    setSelected((prev) => {
      const id = cardId(card)
      if (prev.some((c) => cardId(c) === id)) return prev.filter((c) => cardId(c) !== id)
      if (prev.length >= HAND_SIZE) return prev
      return [...prev, card]
    })
  }, [])

  // 入力（カード or 種類）が変わったら再計算。古いワーカーは terminate でキャンセルする。
  useEffect(() => {
    setEv(null)
    evWorker.current?.terminate()
    evWorker.current = null

    if (selected.length !== HAND_SIZE) {
      solveWorker.current?.terminate()
      solveWorker.current = null
      setResult(null)
      setNoValid(false)
      setSolving(false)
      return
    }

    setSolving(true)
    setNoValid(false)
    solveWorker.current?.terminate()
    const worker = newWorker()
    solveWorker.current = worker
    const id = ++reqId.current

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.kind !== 'solve' || msg.id !== reqId.current) return
      setSolving(false)
      if (msg.ok && msg.best) {
        setResult({
          top: parseCards(msg.best.top),
          middle: parseCards(msg.best.middle),
          bottom: parseCards(msg.best.bottom),
          royalties: msg.best.royalties,
          flCards: msg.best.flCards,
        })
        setNoValid(false)
      } else {
        setResult(null)
        setNoValid(true)
      }
    }

    const req: WorkerRequest = {
      id,
      kind: 'solve',
      cards: selected.map(cardToString),
      variantId,
    }
    worker.postMessage(req)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codes, variantId])

  useEffect(() => {
    return () => {
      solveWorker.current?.terminate()
      evWorker.current?.terminate()
    }
  }, [])

  const estimateEv = useCallback(() => {
    if (!result) return
    evWorker.current?.terminate()
    const worker = newWorker()
    evWorker.current = worker
    setEvRunning(true)
    setEv(null)
    const id = ++reqId.current
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.kind !== 'ev') return
      setEv(msg.ev)
      setEvRunning(false)
      worker.terminate()
      if (evWorker.current === worker) evWorker.current = null
    }
    const req: WorkerRequest = {
      id,
      kind: 'ev',
      top: result.top.map(cardToString),
      middle: result.middle.map(cardToString),
      bottom: result.bottom.map(cardToString),
      variantId,
      iters: EV_ITERS,
    }
    worker.postMessage(req)
  }, [result, variantId])

  const remaining = HAND_SIZE - selected.length

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>{t(lang, 'title')}</h1>
          <p className="subtitle">{t(lang, 'subtitle')}</p>
        </div>
        <button
          type="button"
          className="lang-toggle"
          onClick={() => setLang((l) => (l === 'ja' ? 'en' : 'ja'))}
        >
          {lang === 'ja' ? 'EN' : 'JA'}
        </button>
      </header>

      <div className="controls">
        <label className="variant-select">
          {t(lang, 'variant')}
          <select value={variantId} onChange={(e) => setVariantId(e.target.value as VariantId)}>
            <option value="normal">{t(lang, 'variantNormal')}</option>
            <option value="ultimate">{t(lang, 'variantUltimate')}</option>
          </select>
        </label>
        <div className="count">
          <strong>{selected.length}</strong>/{HAND_SIZE} {t(lang, 'selected')}
        </div>
        <button type="button" className="clear" onClick={() => setSelected([])} disabled={!selected.length}>
          {t(lang, 'clear')}
        </button>
      </div>

      <CardPicker selected={selectedIds} max={HAND_SIZE} onToggle={toggle} />

      <section className="result">
        {remaining > 0 && <p className="hint">{t(lang, 'needCards', { n: remaining })}</p>}
        {remaining === 0 && solving && <p className="hint">{t(lang, 'solving')}</p>}
        {remaining === 0 && !solving && noValid && <p className="hint error">{t(lang, 'noValid')}</p>}
        {remaining === 0 && !solving && result && (
          <ResultView
            lang={lang}
            result={result}
            ev={ev}
            evRunning={evRunning}
            onEstimateEv={estimateEv}
          />
        )}
      </section>
    </main>
  )
}

function Row({ label, cards, hand }: { label: string; cards: Card[]; hand: string }) {
  return (
    <div className="board-row">
      <div className="board-row-head">
        <span className="row-label">{label}</span>
        <span className="row-hand">{hand}</span>
      </div>
      <div className="row-cards">
        {cards.map((c) => (
          <CardGlyph key={cardId(c)} card={c} />
        ))}
      </div>
    </div>
  )
}

function ResultView({
  lang,
  result,
  ev,
  evRunning,
  onEstimateEv,
}: {
  lang: Lang
  result: Result
  ev: number | null
  evRunning: boolean
  onEstimateEv: () => void
}) {
  const flText =
    result.flCards > 0 ? t(lang, 'flCards', { n: result.flCards }) : t(lang, 'flNone')
  return (
    <div className="result-view">
      <Row label={t(lang, 'top')} cards={result.top} hand={handLabel(evaluate3(result.top), lang)} />
      <Row
        label={t(lang, 'middle')}
        cards={result.middle}
        hand={handLabel(evaluate5(result.middle), lang)}
      />
      <Row
        label={t(lang, 'bottom')}
        cards={result.bottom}
        hand={handLabel(evaluate5(result.bottom), lang)}
      />

      <dl className="stats">
        <div>
          <dt>{t(lang, 'royalties')}</dt>
          <dd>{result.royalties}</dd>
        </div>
        <div>
          <dt>{t(lang, 'fantasyland')}</dt>
          <dd>{flText}</dd>
        </div>
        <div>
          <dt>{t(lang, 'ev')}</dt>
          <dd>
            {ev !== null ? (
              <span className={ev >= 0 ? 'pos' : 'neg'}>
                {ev >= 0 ? '+' : ''}
                {ev.toFixed(2)}
              </span>
            ) : evRunning ? (
              t(lang, 'estimatingEv')
            ) : (
              <button type="button" className="ev-btn" onClick={onEstimateEv}>
                {t(lang, 'estimateEv')}
              </button>
            )}
          </dd>
        </div>
      </dl>
      <p className="ev-hint">{t(lang, 'evHint')}</p>
    </div>
  )
}

// ソルバーの Web Worker。重い全探索・モンテカルロを UI スレッド外で実行する。
import {
  type Arrangement,
  type VariantId,
  VARIANTS,
  cardsToString,
  estimateEVvsRandom,
  evaluateArrangement,
  parseCards,
  solveBest13,
} from '../domain'

export interface SolveRequest {
  id: number
  kind: 'solve'
  cards: string[]
  variantId: VariantId
}

export interface EvRequest {
  id: number
  kind: 'ev'
  top: string[]
  middle: string[]
  bottom: string[]
  variantId: VariantId
  iters: number
}

export type WorkerRequest = SolveRequest | EvRequest

export interface SolveResponse {
  id: number
  kind: 'solve'
  ok: boolean
  best?: {
    top: string[]
    middle: string[]
    bottom: string[]
    royalties: number
    flCards: number
  }
  error?: string
}

export interface EvResponse {
  id: number
  kind: 'ev'
  ev: number
}

export type WorkerResponse = SolveResponse | EvResponse

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  const variant = VARIANTS[msg.variantId]

  if (msg.kind === 'solve') {
    try {
      const best = solveBest13(parseCards(msg.cards), variant, { topK: 1, fantasylandBonus: 8 })[0]
      const res: SolveResponse = best
        ? {
            id: msg.id,
            kind: 'solve',
            ok: true,
            best: {
              top: best.arrangement.top.map((c) => cardsToString([c])),
              middle: best.arrangement.middle.map((c) => cardsToString([c])),
              bottom: best.arrangement.bottom.map((c) => cardsToString([c])),
              royalties: best.royalties,
              flCards: best.fantasylandCards,
            },
          }
        : { id: msg.id, kind: 'solve', ok: false }
      ;(self as unknown as Worker).postMessage(res)
    } catch (err) {
      const res: SolveResponse = {
        id: msg.id,
        kind: 'solve',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
      ;(self as unknown as Worker).postMessage(res)
    }
    return
  }

  // ev
  const arrangement: Arrangement = {
    top: parseCards(msg.top),
    middle: parseCards(msg.middle),
    bottom: parseCards(msg.bottom),
  }
  // 念のため評価（無効配置なら EV は estimate 側で自然に反映される）
  evaluateArrangement(arrangement)
  const ev = estimateEVvsRandom(arrangement, [], variant, { iters: msg.iters })
  const res: EvResponse = { id: msg.id, kind: 'ev', ev }
  ;(self as unknown as Worker).postMessage(res)
}

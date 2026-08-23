// ソルバーの Web Worker。重い全探索・モンテカルロを UI スレッド外で実行する。
// リクエスト/レスポンスは structured clone 可能なプレーンオブジェクト（カードは "As" 等の文字列）。
import {
  type Board,
  type BoardSuggestion,
  type CandidateMetric,
  type FantasylandResult,
  type FutureModel,
  type VariantId,
  VARIANTS,
  cardToString,
  estimateEVvsRandomStats,
  evaluateInitialChunk,
  evaluateStreetChunk,
  mulberry32,
  parseCards,
  solveFantasyland,
  stayBonusFor,
  suggestInitial5,
  suggestStreet,
} from '../domain'

export interface BoardDTO {
  top: string[]
  middle: string[]
  bottom: string[]
}

export interface SuggestionDTO extends BoardDTO {
  discarded?: string
  expRoyalty: number
  flProb: number
  foulProb: number
  /** FL 枚数別の突入率（ULTIMATE では 14=QQ, 15=KK, 16=AA, 17=トリップス）。 */
  flBreakdown?: Record<number, number>
  score: number
}

export interface FLResultDTO extends BoardDTO {
  royalties: number
  stays: boolean
  objective: number
}

export type WorkerRequest =
  | {
      id: number
      kind: 'suggestInitial'
      cards: string[]
      dead: string[]
      variantId: VariantId
      iters?: number
      /** ジョーカー2枚入り（54枚デッキ）でプレイしているか。 */
      jokers?: boolean
    }
  | {
      id: number
      kind: 'suggestStreet'
      board: BoardDTO
      drawn: string[]
      dead: string[]
      variantId: VariantId
      iters?: number
      jokers?: boolean
    }
  | {
      id: number
      kind: 'solveFL'
      cards: string[]
      variantId: VariantId
      stayBonus?: number
      jokers?: boolean
      /** bottom 候補の走査範囲 [start, end)。Worker プールでの範囲分割用。省略時は全域。 */
      bottomRange?: [number, number]
      topK?: number
    }
  | {
      id: number
      kind: 'ev'
      board: BoardDTO
      dead: string[]
      variantId: VariantId
      iters: number
      opponents: number
      jokers?: boolean
      /** 決定論的 PRNG のシード。並列チャンクごとに別シードを渡す。 */
      seed?: number
    }
  | {
      id: number
      kind: 'evalInitialChunk'
      cards: string[]
      dead: string[]
      variantId: VariantId
      indices: number[]
      iters: number
      seed: number
      jokers?: boolean
      futureModel?: FutureModel
      /** rollout の内側モンテカルロ反復数（解析精度で増量する）。 */
      rolloutInner?: number
    }
  | {
      id: number
      kind: 'evalStreetChunk'
      board: BoardDTO
      drawn: string[]
      dead: string[]
      variantId: VariantId
      indices: number[]
      iters: number
      seed: number
      jokers?: boolean
      futureModel?: FutureModel
      rolloutInner?: number
    }

export type WorkerResponse =
  | { id: number; kind: 'progress'; done: number; total: number }
  | { id: number; kind: 'suggestions'; suggestions: SuggestionDTO[] }
  | { id: number; kind: 'fl'; results: FLResultDTO[] }
  | { id: number; kind: 'ev'; ev: number; n: number; m2: number }
  | { id: number; kind: 'chunk'; results: CandidateMetric[] }
  | { id: number; kind: 'error'; message: string }

function post(res: WorkerResponse): void {
  ;(self as unknown as Worker).postMessage(res)
}

function toBoard(dto: BoardDTO): Board {
  return {
    top: parseCards(dto.top),
    middle: parseCards(dto.middle),
    bottom: parseCards(dto.bottom),
  }
}

function boardDTO(board: Board): BoardDTO {
  return {
    top: board.top.map(cardToString),
    middle: board.middle.map(cardToString),
    bottom: board.bottom.map(cardToString),
  }
}

function suggestionDTO(s: BoardSuggestion): SuggestionDTO {
  return {
    ...boardDTO(s.board),
    discarded: s.discarded ? cardToString(s.discarded) : undefined,
    expRoyalty: s.expRoyalty,
    flProb: s.flProb,
    foulProb: s.foulProb,
    flBreakdown: s.flBreakdown,
    score: s.score,
  }
}

function flDTO(r: FantasylandResult): FLResultDTO {
  return {
    ...boardDTO(r.arrangement),
    royalties: r.royalties,
    stays: r.stays,
    objective: r.objective,
  }
}

// 進捗はメッセージ数を抑えるため間引いて送る。
function progressReporter(id: number): (done: number, total: number) => void {
  let last = -1
  return (done, total) => {
    const pct = Math.floor((done / total) * 50)
    if (pct !== last || done === total) {
      last = pct
      post({ id, kind: 'progress', done, total })
    }
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  const variant = VARIANTS[msg.variantId]
  try {
    switch (msg.kind) {
      case 'suggestInitial': {
        const suggestions = suggestInitial5(parseCards(msg.cards), parseCards(msg.dead), variant, {
          iters: msg.iters ?? 120,
          jokers: msg.jokers,
          onProgress: progressReporter(msg.id),
        })
        post({ id: msg.id, kind: 'suggestions', suggestions: suggestions.slice(0, 5).map(suggestionDTO) })
        break
      }
      case 'suggestStreet': {
        const suggestions = suggestStreet(
          toBoard(msg.board),
          parseCards(msg.drawn),
          parseCards(msg.dead),
          variant,
          { iters: msg.iters ?? 160, jokers: msg.jokers, onProgress: progressReporter(msg.id) },
        )
        post({ id: msg.id, kind: 'suggestions', suggestions: suggestions.slice(0, 5).map(suggestionDTO) })
        break
      }
      case 'solveFL': {
        // リステイボーナス既定値 = 実測した V(14)（デッキに応じて 52枚用 / ジョーカー入り用）。
        const flCards = parseCards(msg.cards)
        const results = solveFantasyland(flCards, variant, {
          // リステイボーナス = 種類のリステイ枚数ルールに従った V（同枚数維持なら V(n)、14枚戻りなら V(14)）
          stayBonus: msg.stayBonus ?? stayBonusFor(flCards.length, msg.jokers ?? false, variant),
          topK: msg.topK ?? 3,
          bottomRange: msg.bottomRange,
        })
        post({ id: msg.id, kind: 'fl', results: results.map(flDTO) })
        break
      }
      case 'ev': {
        const board = toBoard(msg.board)
        const stats = estimateEVvsRandomStats(board, parseCards(msg.dead), variant, {
          iters: msg.iters,
          opponents: msg.opponents,
          jokers: msg.jokers,
          rng: msg.seed !== undefined ? mulberry32(msg.seed) : undefined,
        })
        post({ id: msg.id, kind: 'ev', ev: stats.mean, n: stats.n, m2: stats.m2 })
        break
      }
      case 'evalInitialChunk': {
        const results = evaluateInitialChunk(
          parseCards(msg.cards),
          parseCards(msg.dead),
          variant,
          msg.indices,
          {
            iters: msg.iters,
            seed: msg.seed,
            jokers: msg.jokers,
            futureModel: msg.futureModel,
            rolloutInner: msg.rolloutInner,
            onProgress: progressReporter(msg.id),
          },
        )
        post({ id: msg.id, kind: 'chunk', results })
        break
      }
      case 'evalStreetChunk': {
        const results = evaluateStreetChunk(
          toBoard(msg.board),
          parseCards(msg.drawn),
          parseCards(msg.dead),
          variant,
          msg.indices,
          {
            iters: msg.iters,
            seed: msg.seed,
            jokers: msg.jokers,
            futureModel: msg.futureModel,
            rolloutInner: msg.rolloutInner,
            onProgress: progressReporter(msg.id),
          },
        )
        post({ id: msg.id, kind: 'chunk', results })
        break
      }
    }
  } catch (err) {
    post({ id: msg.id, kind: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

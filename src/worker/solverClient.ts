// Worker プールと、その上の並列ソルバー・クライアント。
//
// - Worker はプールで使い回す（リクエストごとの生成・モジュール初期化コストを避ける）。
//   プールサイズは hardwareConcurrency - 1（1..6 にクランプ）。
// - キャンセル: キュー中のジョブは取り消すだけ。実行中のジョブは Worker を terminate して
//   作り直す（JS の Worker は計算中に中断できないため）。
// - 候補集合はコア数に応じたチャンクに分割して投げる。候補ごとに独立シードの決定論的 PRNG を
//   使うため、分割の仕方によらず結果は単一 Worker 実行と一致する（solverParallel.test.ts）。

import {
  type Board,
  type BoardMetric,
  type Card,
  type FutureModel,
  type VariantId,
  cardToString,
  choose,
  generateInitialBoards,
  generateStreetBoards,
} from '../domain'
import type {
  BoardDTO,
  FLResultDTO,
  SuggestionDTO,
  WorkerRequest,
  WorkerResponse,
} from './solver.worker'

export class CanceledError extends Error {
  constructor() {
    super('canceled')
    this.name = 'CanceledError'
  }
}

export interface PoolTask<T> {
  promise: Promise<T>
  cancel: () => void
}

interface Job {
  req: WorkerRequest
  resolve: (msg: WorkerResponse) => void
  reject: (err: Error) => void
  onProgress?: (done: number, total: number) => void
}

interface Slot {
  worker: Worker
  job: Job | null
}

function newWorker(): Worker {
  return new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' })
}

export function defaultPoolSize(): number {
  const hc =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 2
  return Math.max(1, Math.min(hc - 1, 6))
}

class WorkerPool {
  private slots: Slot[] = []
  private queue: Job[] = []
  private counter = 0

  constructor(readonly size: number) {}

  /** Worker を先に起動してモジュール初期化を済ませておく（初回リクエストの体感短縮）。 */
  warmup(): void {
    this.ensureSlots()
  }

  private ensureSlots(): void {
    while (this.slots.length < this.size) {
      const slot: Slot = { worker: newWorker(), job: null }
      this.attach(slot)
      this.slots.push(slot)
    }
  }

  private attach(slot: Slot): void {
    slot.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const job = slot.job
      if (!job || e.data.id !== job.req.id) return
      if (e.data.kind === 'progress') {
        job.onProgress?.(e.data.done, e.data.total)
        return
      }
      slot.job = null
      if (e.data.kind === 'error') job.reject(new Error(e.data.message))
      else job.resolve(e.data)
      this.pump()
    }
    slot.worker.onerror = (e) => {
      const job = slot.job
      slot.job = null
      job?.reject(new Error(e.message || 'worker error'))
      this.pump()
    }
  }

  submit(
    req: WorkerRequest,
    onProgress?: (done: number, total: number) => void,
  ): PoolTask<WorkerResponse> {
    req.id = ++this.counter
    let job!: Job
    const promise = new Promise<WorkerResponse>((resolve, reject) => {
      job = { req, resolve, reject, onProgress }
    })
    this.queue.push(job)
    this.ensureSlots()
    this.pump()
    const cancel = () => {
      const qi = this.queue.indexOf(job)
      if (qi >= 0) {
        this.queue.splice(qi, 1)
        job.reject(new CanceledError())
        return
      }
      const slot = this.slots.find((s) => s.job === job)
      if (slot) {
        slot.worker.terminate()
        slot.job = null
        slot.worker = newWorker()
        this.attach(slot)
        job.reject(new CanceledError())
        this.pump()
      }
    }
    return { promise, cancel }
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (this.queue.length === 0) return
      if (slot.job) continue
      const job = this.queue.shift()!
      slot.job = job
      slot.worker.postMessage(job.req)
    }
  }
}

export const solverPool = new WorkerPool(defaultPoolSize())

// ---- チャンク実行の共通部 ------------------------------------------------------

interface ChunkSpec {
  req: WorkerRequest
  /** 進捗集約上の重み（このチャンクが占める仕事量）。 */
  units: number
}

/** 複数チャンクを並列実行し、進捗を集約する。1つでも失敗したら残りをキャンセルする。 */
function runChunks(
  specs: ChunkSpec[],
  onProgress?: (done: number, total: number) => void,
): PoolTask<WorkerResponse[]> {
  const totalUnits = specs.reduce((s, c) => s + c.units, 0)
  const done = new Array<number>(specs.length).fill(0)
  const report = () => onProgress?.(done.reduce((a, b) => a + b, 0), totalUnits)
  const tasks = specs.map((spec, i) =>
    solverPool.submit(spec.req, (d, t) => {
      done[i] = t > 0 ? (d / t) * spec.units : 0
      report()
    }),
  )
  const promise = Promise.all(
    tasks.map((task, i) =>
      task.promise.then((res) => {
        done[i] = specs[i].units
        report()
        return res
      }),
    ),
  ).catch((err) => {
    for (const task of tasks) task.cancel()
    throw err
  })
  return { promise, cancel: () => tasks.forEach((t) => t.cancel()) }
}

function splitIndices(total: number, parts: number): number[][] {
  if (total === 0) return []
  const per = Math.ceil(total / Math.max(1, parts))
  const out: number[][] = []
  for (let start = 0; start < total; start += per) {
    const len = Math.min(per, total - start)
    out.push(Array.from({ length: len }, (_, j) => start + j))
  }
  return out
}

/**
 * 局面から決定論的にシードを導出する（FNV-1a）。同じ局面・同じ設定なら常に同じ
 * 「未来の引き」のセットで評価されるため、再計算しても推奨手・EV が変わらない。
 */
function hashSeed(...parts: (string | number | boolean)[]): number {
  let h = 0x811c9dc5
  for (const part of parts) {
    const s = String(part)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    h ^= 0x7c
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function boardDTO(board: Board): BoardDTO {
  return {
    top: board.top.map(cardToString),
    middle: board.middle.map(cardToString),
    bottom: board.bottom.map(cardToString),
  }
}

function toSuggestionDTO(
  board: Board,
  discarded: Card | undefined,
  m: BoardMetric,
): SuggestionDTO {
  return {
    ...boardDTO(board),
    discarded: discarded ? cardToString(discarded) : undefined,
    expRoyalty: m.expRoyalty,
    flProb: m.flProb,
    foulProb: m.foulProb,
    flBreakdown: m.flBreakdown,
    score: m.score,
  }
}

function chunkResults(responses: WorkerResponse[]) {
  return responses.flatMap((r) => (r.kind === 'chunk' ? r.results : []))
}

const TOP_N = 5
const REFINE_TOP_K = 10

// ---- 公開タスク ----------------------------------------------------------------

export interface SuggestInitialParams {
  cards: Card[]
  dead: Card[]
  variantId: VariantId
  jokers: boolean
  iters: number
  /** 精評価段に使う未来モデル（省略時は evaluateBoard の既定 'policy'）。 */
  futureModel?: FutureModel
}

/**
 * 初手5枚の推奨（2段階モンテカルロをプール全体へ分割）。
 * 1次: 全候補を荒い反復で並列評価 → 2次: 上位 REFINE_TOP_K のみ本反復で精評価。
 */
export function suggestInitialParallel(
  params: SuggestInitialParams,
  onProgress?: (frac: number) => void,
): PoolTask<SuggestionDTO[]> {
  const { cards, dead, variantId, jokers, iters, futureModel } = params
  const boards = generateInitialBoards(cards)
  // rollout の精評価は1本あたりが重い分、粗選別を厚くして取りこぼしを防ぐ。
  const coarseIters =
    futureModel === 'rollout' ? Math.max(120, Math.round(iters / 2)) : Math.max(8, Math.round(iters / 8))
  const refineTopK = futureModel === 'rollout' ? 16 : REFINE_TOP_K
  const totalUnits = boards.length + refineTopK
  const cardCodes = cards.map(cardToString)
  const deadCodes = dead.map(cardToString)
  const seed = hashSeed('initial', cardCodes.join(), deadCodes.join(), variantId, jokers, iters, futureModel ?? '')

  let canceled = false
  let inner: PoolTask<WorkerResponse[]> | null = null

  const chunkReq = (
    indices: number[],
    chunkIters: number,
    chunkSeed: number,
    model?: FutureModel,
  ): WorkerRequest => ({
    id: 0,
    kind: 'evalInitialChunk',
    cards: cardCodes,
    dead: deadCodes,
    variantId,
    jokers,
    indices,
    iters: chunkIters,
    seed: chunkSeed,
    futureModel: model,
  })

  const run = async (): Promise<SuggestionDTO[]> => {
    // 粗選別は精評価と選好が揃うモデルで行う（rollout の粗選別に policy を使うと
    // FLチェイス寄りの候補ばかりが精評価に残り、真の上位を取りこぼす）。
    const coarseModel = futureModel === 'rollout' ? 'streets' : undefined
    const coarseSpecs = splitIndices(boards.length, solverPool.size).map((indices) => ({
      units: indices.length,
      req: chunkReq(indices, coarseIters, seed, coarseModel),
    }))
    inner = runChunks(coarseSpecs, (d) => onProgress?.(d / totalUnits))
    const coarse = chunkResults(await inner.promise)
    if (canceled) throw new CanceledError()
    coarse.sort((a, b) => b.score - a.score)

    const refineIdx = coarse.slice(0, refineTopK).map((c) => c.index)
    const refineSpecs = splitIndices(refineIdx.length, solverPool.size).map((slice) => ({
      units: slice.length,
      req: chunkReq(slice.map((i) => refineIdx[i]), iters, seed + 1, futureModel),
    }))
    inner = runChunks(refineSpecs, (d) => onProgress?.((boards.length + d) / totalUnits))
    const refined = chunkResults(await inner.promise)
    if (canceled) throw new CanceledError()
    refined.sort((a, b) => b.score - a.score)
    onProgress?.(1)

    // 精評価済みを上位に、残りは荒い評価のまま（suggestInitial5 と同じ並び）。
    const refinedIds = new Set(refined.map((m) => m.index))
    const rest = coarse.filter((m) => !refinedIds.has(m.index))
    return [...refined, ...rest]
      .slice(0, TOP_N)
      .map((m) => toSuggestionDTO(boards[m.index], undefined, m))
  }

  return {
    promise: run(),
    cancel: () => {
      canceled = true
      inner?.cancel()
    },
  }
}

export interface SuggestStreetParams {
  board: Board
  drawn: Card[]
  dead: Card[]
  variantId: VariantId
  jokers: boolean
  iters: number
  futureModel?: FutureModel
}

/** ストリート手の推奨（候補をプール全体へ分割評価）。 */
export function suggestStreetParallel(
  params: SuggestStreetParams,
  onProgress?: (frac: number) => void,
): PoolTask<SuggestionDTO[]> {
  const { board, drawn, dead, variantId, jokers, iters, futureModel } = params
  const candidates = generateStreetBoards(board, drawn)
  const dto = boardDTO(board)
  const drawnCodes = drawn.map(cardToString)
  const deadCodes = dead.map(cardToString)
  const seed = hashSeed(
    'street',
    dto.top.join(),
    dto.middle.join(),
    dto.bottom.join(),
    drawnCodes.join(),
    deadCodes.join(),
    variantId,
    jokers,
    iters,
    futureModel ?? '',
  )

  const specs = splitIndices(candidates.length, solverPool.size).map((indices) => ({
    units: indices.length,
    req: {
      id: 0,
      kind: 'evalStreetChunk',
      board: dto,
      drawn: drawnCodes,
      dead: deadCodes,
      variantId,
      jokers,
      indices,
      iters,
      seed,
      futureModel,
    } satisfies WorkerRequest,
  }))
  const inner = runChunks(specs, (d, t) => onProgress?.(t > 0 ? d / t : 0))
  const promise = inner.promise.then((responses) => {
    const metrics = chunkResults(responses)
    metrics.sort((a, b) => b.score - a.score)
    return metrics
      .slice(0, TOP_N)
      .map((m) => toSuggestionDTO(candidates[m.index].board, candidates[m.index].discarded, m))
  })
  return { promise, cancel: inner.cancel }
}

export interface EvParams {
  board: Board
  dead: Card[]
  variantId: VariantId
  jokers: boolean
  opponents: number
  iters: number
}

export interface EvResult {
  mean: number
  n: number
  /** 95% 信頼区間の半幅（±この値）。 */
  ci95: number
}

/** モンテカルロ EV をプール全体へ分割し、統計量を Chan の公式で統合する。 */
export function estimateEvParallel(
  params: EvParams,
  onProgress?: (frac: number) => void,
): PoolTask<EvResult> {
  const { board, dead, variantId, jokers, opponents, iters } = params
  // 1チャンクあたり最低50反復は確保する（分割しすぎのオーバーヘッド回避）。
  const parts = Math.max(1, Math.min(solverPool.size, Math.floor(iters / 50)))
  const per = Math.ceil(iters / parts)
  const dto = boardDTO(board)
  const deadCodes = dead.map(cardToString)
  const baseSeed = hashSeed(
    'ev',
    dto.top.join(),
    dto.middle.join(),
    dto.bottom.join(),
    deadCodes.join(),
    variantId,
    jokers,
    opponents,
    iters,
  )

  const specs: ChunkSpec[] = []
  for (let i = 0, remaining = iters; remaining > 0; i++, remaining -= per) {
    const chunkIters = Math.min(per, remaining)
    specs.push({
      units: chunkIters,
      req: {
        id: 0,
        kind: 'ev',
        board: dto,
        dead: deadCodes,
        variantId,
        jokers,
        opponents,
        iters: chunkIters,
        seed: (baseSeed + i * 0x9e3779b9) >>> 0,
      },
    })
  }
  const inner = runChunks(specs, (d, t) => onProgress?.(t > 0 ? d / t : 0))
  const promise = inner.promise.then((responses) => {
    let n = 0
    let mean = 0
    for (const r of responses) {
      if (r.kind !== 'ev' || r.n === 0) continue
      n += r.n
      mean += r.n * r.ev
    }
    if (n === 0) return { mean: 0, n: 0, ci95: 0 }
    mean /= n
    let m2 = 0
    for (const r of responses) {
      if (r.kind !== 'ev' || r.n === 0) continue
      m2 += r.m2 + r.n * (r.ev - mean) ** 2
    }
    const ci95 = n > 1 ? 1.96 * Math.sqrt(m2 / (n - 1) / n) : 0
    return { mean, n, ci95 }
  })
  return { promise, cancel: inner.cancel }
}

export interface FLParams {
  cards: Card[]
  variantId: VariantId
  jokers: boolean
}

/** FL 全探索を bottom 候補の範囲で分割し、範囲ごとの topK を目的値降順にマージする。 */
export function solveFLParallel(
  params: FLParams,
  onProgress?: (frac: number) => void,
): PoolTask<FLResultDTO[]> {
  const { cards, variantId, jokers } = params
  const topK = 3
  const n5 = choose(cards.length, 5)
  const parts = Math.max(1, Math.min(solverPool.size, Math.ceil(n5 / 200)))
  const per = Math.ceil(n5 / parts)
  const cardCodes = cards.map(cardToString)

  const specs: ChunkSpec[] = []
  for (let start = 0; start < n5; start += per) {
    const end = Math.min(start + per, n5)
    specs.push({
      units: end - start,
      req: {
        id: 0,
        kind: 'solveFL',
        cards: cardCodes,
        variantId,
        jokers,
        bottomRange: [start, end],
        topK,
      },
    })
  }
  const inner = runChunks(specs, (d, t) => onProgress?.(t > 0 ? d / t : 0))
  const promise = inner.promise.then((responses) => {
    const all = responses.flatMap((r) => (r.kind === 'fl' ? r.results : []))
    return all.sort((a, b) => b.objective - a.objective).slice(0, topK)
  })
  return { promise, cancel: inner.cancel }
}

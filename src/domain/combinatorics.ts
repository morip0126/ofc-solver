// 組み合わせ・シャッフルのユーティリティ。
// Combination and shuffle utilities.

/** items から k 個を選ぶ全組み合わせを列挙する（順序は選択順、非破壊）。 */
export function combinations<T>(items: readonly T[], k: number): T[][] {
  const n = items.length
  if (k < 0 || k > n) return []
  if (k === 0) return [[]]
  if (k === n) return [items.slice()]

  const result: T[][] = []
  const idx: number[] = []
  for (let i = 0; i < k; i++) idx.push(i)

  while (true) {
    result.push(idx.map((i) => items[i]))

    // 次の組み合わせへ / advance to the next combination
    let i = k - 1
    while (i >= 0 && idx[i] === n - k + i) i--
    if (i < 0) break
    idx[i]++
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1
  }
  return result
}

/** nCk の値。列挙前のサイズ見積もりに使う。 */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  k = Math.min(k, n - k)
  let result = 1
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1)
  return Math.round(result)
}

/**
 * Fisher–Yates シャッフル（in-place）。
 * rng は [0,1) を返す関数。省略時は Math.random。
 * テストの再現性のために外から決定論的 rng を注入できる。
 */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/**
 * mulberry32: 32bit シードの決定論的 PRNG。
 * Monte Carlo の再現性確保に使う。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

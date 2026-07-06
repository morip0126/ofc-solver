import { useMemo, useState } from 'react'
import { parseCards, solveBest13, cardsToString, VARIANTS, type VariantId } from './domain'

// 暫定の動作確認用 UI。本格的な盤面 UI は次のマイルストーンで実装する。
// ここでは「既知13枚の最善配列（ロイヤリティ最大）」ソルバーを試せるようにしている。
export default function App() {
  const [input, setInput] = useState('As Ks Qs Js Ts 2c 2d 2h 5c 7d 9h 4s 6s')
  const [variantId, setVariantId] = useState<VariantId>('normal')

  const result = useMemo(() => {
    try {
      const cards = parseCards(input)
      if (cards.length !== 13) return { error: `13枚入力してください（現在 ${cards.length} 枚）` }
      const best = solveBest13(cards, VARIANTS[variantId], { topK: 1, fantasylandBonus: 8 })[0]
      if (!best) return { error: '非ファウルの配列が見つかりませんでした' }
      return { best }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [input, variantId])

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20 }}>OFC Solver</h1>
      <p style={{ color: '#666', fontSize: 13 }}>
        Pineapple OFC のロジックコア（動作確認用の暫定 UI）。既知13枚の最善配列を全探索します。
      </p>

      <label style={{ display: 'block', marginTop: 12, fontSize: 13 }}>
        13枚（例: As Ks Qs ...）
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          style={{ width: '100%', marginTop: 4, fontFamily: 'monospace' }}
        />
      </label>

      <label style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
        種類{' '}
        <select value={variantId} onChange={(e) => setVariantId(e.target.value as VariantId)}>
          {Object.entries(VARIANTS).map(([id, v]) => (
            <option key={id} value={id}>
              {v.name.ja}
            </option>
          ))}
        </select>
      </label>

      <section style={{ marginTop: 16 }}>
        {'error' in result ? (
          <p style={{ color: '#c00' }}>{result.error}</p>
        ) : (
          <div style={{ fontFamily: 'monospace', lineHeight: 1.7 }}>
            <div>top:    {cardsToString(result.best.arrangement.top)}</div>
            <div>middle: {cardsToString(result.best.arrangement.middle)}</div>
            <div>bottom: {cardsToString(result.best.arrangement.bottom)}</div>
            <div style={{ marginTop: 8 }}>
              royalties: {result.best.royalties} / FL cards: {result.best.fantasylandCards}
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

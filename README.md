# OFC Solver

パイナップル OFC（Open Face Chinese poker）のソルバー。
Vite + React + TypeScript。重い計算は将来的に Web Worker に載せる想定。

> **現状: ロジックコア（v1）**
> まずドメインロジックとテストを固めた段階です。本格的な盤面 UI は次のマイルストーンで実装します。
> 現状の `src/App.tsx` は動作確認用の暫定 UI（既知13枚の最善配列を全探索）です。

## 対応する種類（Variant）

- **Normal**: top が QQ 以上のペア、またはスリーカードでファンタジーランド（14枚）。
- **Ultimate（プログレッシブ FL）**: QQ=14 / KK=15 / AA=16 / top トリップス=17 枚。

種類は `src/domain/variants.ts` の `Variant` として定義し、差し替え可能。
ロイヤリティ表は広く使われている標準表（`src/domain/royalties.ts`）を共有します。
実際のルームによって細部（FL枚数・リステイ条件・ロイヤリティ）は異なるため、必要に応じて調整してください。

## ドメイン構成（`src/domain/`）

| ファイル | 役割 |
| --- | --- |
| `cards.ts` | カード表現・パース・デッキ操作 |
| `combinatorics.ts` | 組み合わせ列挙・シャッフル・決定論的 PRNG |
| `evaluator.ts` | ハンド評価（5枚 / 3枚）と比較 |
| `royalties.ts` | ロイヤリティ表 |
| `variants.ts` | 種類（Normal / Ultimate）とファンタジーランド規則 |
| `score.ts` | ファウル判定・合計ロイヤリティ・対戦スコアリング |
| `solver.ts` | 最善配列の全探索 / モンテカルロ EV / ストリート推奨 |

## ソルバーが提供する機能

- `solveBest13(cards, variant)` — 既知13枚から、ファウルしない最善配列（ロイヤリティ最大）を全探索（決定論的）。
- `estimateEVvsRandom(arrangement, dead, variant)` — 完成配置のランダム相手に対する期待得点をモンテカルロ推定。
- `rankByEV(candidates, dead, variant)` — 候補配列を EV で再ランク。
- `suggestInitial5(cards, dead, variant)` — 初手5枚の置き方を推定（楽観的補完 + モンテカルロ）。
- `suggestStreet(board, drawn, dead, variant)` — 各ストリート（3枚引いて2枚置き1枚捨て）の最善手を推定。

`suggestInitial5` / `suggestStreet` は「以降の引きは最適に配置できる」という**楽観的補完**に基づくヒューリスティック。
相対的な手の優劣付けには機能しますが、相手を考慮した厳密な逐次最適化ではありません。

## 開発

```bash
pnpm install
pnpm dev      # 開発サーバ
pnpm build    # 本番ビルド（tsc -b && vite build）
pnpm test     # vitest（--testTimeout=20000）
```

## 今後の課題（Next steps）

- 盤面 UI（カード選択・3段ボード・ストリート進行・推奨表示、i18n ja/en）。
- ハンド評価の高速化（`estimateEVvsRandom` は相手ごとに全探索するため重い）。
- 相手を考慮した逐次最適化（現状は楽観的補完のヒューリスティック）。
- ファンタジーランド中（13〜17枚一括）の最適配置ソルバー。
- ロイヤリティ / FL 規則をルーム別プリセットとして拡充。

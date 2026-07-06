# OFC Solver

パイナップル OFC（Open Face Chinese poker）の実戦アシスタント / ソルバー。
Vite + React + TypeScript。重い計算は Web Worker で実行。

## できること

- **実戦アシスタント（プレイモード）**: 初手5枚 → 各ストリート（3枚引いて2枚置き1枚捨て）を
  対話的に進め、各局面の推奨配置を表示（期待ロイヤリティ / FL率 / ファウル率）。
  推奨の「採用」でも、カードごとの手動割当でも進められる。
- **相手盤面の入力**: Villain（1〜2人）の見えているカードを入力すると、デッドカードとして
  引き確率・EV に反映される。2人（HU）/ 3人打ちに対応（ペアワイズ採点）。
- **ファンタジーランド・ソルバー（FLモード）**: FL 配牌（13〜17枚）から最善の13枚配置を
  全探索（リステイ考慮）。
- **EV 推定**: 完成した13枚のランダム相手（1〜2人）に対する期待得点をモンテカルロ推定。
  全員の盤面が完成していれば確定スコアも表示。
- i18n（ja/en）、モバイル幅（375px）対応。

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
| `evaluator.ts` | ハンド評価（5枚 / 3枚）と比較（参照実装） |
| `fastEval.ts` | 24bit パックキーによる高速評価（ホットパス用） |
| `royalties.ts` | ロイヤリティ表 |
| `variants.ts` | 種類（Normal / Ultimate）とファンタジーランド規則 |
| `score.ts` | ファウル判定・合計ロイヤリティ・対戦スコアリング（HU / マルチ） |
| `solver.ts` | 最善配列の全探索 / FL ソルバー / モンテカルロ EV / ストリート推奨 |

## ソルバーが提供する機能

- `solveBest13(cards, variant)` — 既知13枚から、ファウルしない最善配列（ロイヤリティ最大）を全探索（決定論的）。
- `solveFantasyland(cards, variant)` — FL 中の13〜17枚から最善の13枚配置を全探索。
  目的関数 = ロイヤリティ + リステイボーナス。17枚（C(17,5)² ≒ 3,800万ペア）でも
  パックキーの整数比較のみで Worker 上 1秒前後。
- `estimateEVvsRandom(arrangement, dead, variant, { opponents })` — ランダム相手（1〜複数）に
  対する期待得点をモンテカルロ推定（ペアワイズ採点）。
- `rankByEV(candidates, dead, variant)` — 候補配列を EV で再ランク。
- `suggestInitial5(cards, dead, variant)` — 初手5枚の置き方を推定（2段階モンテカルロ: 全232通りを
  荒く評価 → 上位のみ精評価）。
- `suggestStreet(board, drawn, dead, variant)` — 各ストリートの最善手を推定。
- `scoreMultiEvaluated(players, variant)` — 3人打ちのペアワイズ採点（ゼロサム）。

`suggestInitial5` / `suggestStreet` は「以降の引きは最適に配置できる」という**楽観的補完**に基づく
ヒューリスティック。相対的な手の優劣付けには機能しますが、相手を考慮した厳密な逐次最適化ではありません。

### 数値の正しさ

高速パス（`fastEval.ts` / `solver.ts` のパックキー探索）は、素朴な参照実装
（`evaluator.ts` + `combinations`）とのクロスチェックテストで同値性を担保しています
（`fastEval.test.ts`, `solverFast.test.ts`）。

## スマホで使う（GitHub Pages）

デフォルトブランチへの push で GitHub Actions（`.github/workflows/deploy.yml`）が
テスト → ビルド → GitHub Pages へ自動デプロイします。公開 URL:

```
https://morip0126.github.io/ofc-solver/
```

- 初回はリポジトリの Actions が有効であること（Settings → Actions）と、Pages の
  Source が「GitHub Actions」になっていることを確認（ワークフローが自動で有効化を試みます）。
- スマホのブラウザで開き、**「ホーム画面に追加」**するとスタンドアロン表示で
  アプリのように使えます（manifest / アイコン同梱）。
- 完全にクライアントサイドで動作するためサーバは不要。一度読み込めば計算は端末内で行われます。

開発中に同一 Wi-Fi のスマホから試すには:

```bash
pnpm dev --host   # 表示される Network の URL をスマホで開く
```

## 開発

```bash
pnpm install
pnpm dev      # 開発サーバ
pnpm build    # 本番ビルド（tsc -b && vite build）
pnpm test     # vitest（--testTimeout=20000）
```

## 今後の課題（Next steps）

- 相手を考慮した逐次最適化（現状は楽観的補完のヒューリスティック）。
- 推奨スコアの重み（FL率ボーナス / ファウル率ペナルティ）のチューニング・設定化。
- ロイヤリティ / FL 規則をルーム別プリセットとして拡充。
- Villain の FL 状態（14枚配牌など）の考慮。

# 開発メモ（OFC Solver）

パイナップル OFC（Open Face Chinese poker）のソルバー。Vite + React + TypeScript。
重い計算は将来的に Web Worker に載せる想定（MixMage と同じ流儀）。

## ビルド / 確認

- 本番ビルド: `pnpm build`（= `tsc -b && vite build`）。**push 前に必ず通す**。
- テスト: `pnpm test`（vitest、モンテカルロが重いので `--testTimeout=20000`）。
- UI を触ったらブラウザ（モバイル幅375px・デスクトップ）で実機確認する。横スクロールは最終手段。

## 作業の進め方

- **コミット / プッシュはユーザーが指示したときだけ**。勝手にやらない。
- **プッシュ前の順序**: `pnpm build` を通す → 必要ならブラウザ確認 → コミット → プッシュ。
- **コミットメッセージは英語1行**。末尾に必ず:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **i18n は ja/en 両方**を必ず追加する（UI 実装時）。
- **用語の統一**: エクイティ/期待値の表示は EQ / EV。プレイヤー名は Hero / Villain。
- **数値検証**: ロイヤリティ・ポット分配・確率が疑わしいときは、独立実装や決定論的テストでクロスチェックしてから結論を出す。

## ドメイン設計メモ

- 種類（Variant）は `src/domain/variants.ts`。FL 規則の違いはここに集約（ロイヤリティ表は `royalties.ts` を共有）。
- ハンド評価 `evaluator.ts`: `HandValue = [category, ...tiebreakers]`。辞書式比較で強弱が決まる。top は 3枚評価。
- ファウル = bottom ≥ middle ≥ top を満たさない配置（`score.ts`）。
- ソルバー `solver.ts`: `solveBest13`（全探索・決定論的）/ `estimateEVvsRandom`（モンテカルロ）/
  `suggestInitial5`・`suggestStreet`（楽観的補完のヒューリスティック）。
- モンテカルロは決定論的 PRNG（`combinatorics.ts` の `mulberry32`）を注入してテストの再現性を確保する。

## 注意

- ロイヤリティ / FL 規則はルームによって差があるので、標準を実装しつつ差し替え可能にしている。
- `estimateEVvsRandom` は相手ごとに全探索するため重い。UI に載せるときは高速化が必要。

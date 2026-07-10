# 開発メモ（OFC Solver）

パイナップル OFC（Open Face Chinese poker）の実戦アシスタント / ソルバー。Vite + React + TypeScript。
重い計算は Web Worker で実行（MixMage と同じ流儀）。

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
  これは**参照実装**。ホットパスは `fastEval.ts` の 24bit パックキー（整数比較・アロケーションなし）で動く。
  **高速パスを触ったら、参照実装とのクロスチェックテスト（`fastEval.test.ts` / `solverFast.test.ts`）を必ず維持・更新する。**
- ジョーカー（54枚デッキ）: `rank: 0` のワイルド2枚（`cards.ts` の `JOKER_CARDS`、ID 52/53、コード "X1"/"X2"）。
  「その段の役を最強にするカード」として段ごとに独立最大化（5オブアカインドは無し）。参照実装は置換総当たり、
  高速パスは直接構成（`fastEval.ts` の `key5Wild`）。**ワイルド周りを触ったら `fastEvalWild.test.ts` の
  全数クロスチェック（1ジョーカー C(52,4) / 2ジョーカー C(52,3)）を必ず通すこと。**
- ファウル = bottom ≥ middle ≥ top を満たさない配置（`score.ts`）。3人打ちは `scoreMultiEvaluated`（ペアワイズ・ゼロサム）。
- ソルバー `solver.ts`: `solveBest13`（全探索・決定論的）/ `solveFantasyland`（13〜17枚、リステイ考慮）/
  `estimateEVvsRandom`（`opponents` で複数のランダム相手に対応）/
  `suggestInitial5`・`suggestStreet`（楽観的補完のヒューリスティック、荒→精の2段階MC）。
- FL 継続率: `flStay.ts` の `stayFeasibility` がリステイ可能性を厳密判定（`solveFantasyland` との
  クロスチェックテストで担保）。継続率の再計測は `FL_STAY_ITERS=500000 pnpm vitest run src/domain/flStayRate.test.ts --testTimeout=3600000`。
- モンテカルロは決定論的 PRNG（`combinatorics.ts` の `mulberry32`）を注入してテストの再現性を確保する。
- **並列計算**: `src/worker/solverClient.ts` の Worker プールが候補集合をチャンク分割して実行する。
  分割の入口はドメイン側のチャンク API（`evaluateInitialChunk` / `evaluateStreetChunk`、
  FL は `solveFantasyland` の `bottomRange`、EV は `estimateEVvsRandomStats` のシード分割 +
  Chan の公式で統合）。**候補ごとに独立シードの PRNG を使うため分割不変**。この性質は
  `solverParallel.test.ts` で担保しているので、チャンク API を触ったら必ず維持・更新する。
- UI は実戦アシスタント（`App.tsx`）: プレイモード（初手→ストリート進行 + 推奨手）と FL モード。
  Worker プロトコルは `solver.worker.ts`（evalInitialChunk / evalStreetChunk / solveFL / ev ほか）。
  設定・盤面は `persist.ts` が localStorage に自動保存（スキーマ変更時はキーの版数を上げる）。
  オフライン対応は `vite-plugin-pwa` の Service Worker（`vite.config.ts`）。

## 注意

- ロイヤリティ / FL 規則はルームによって差があるので、標準を実装しつつ差し替え可能にしている。
- 推奨手のスコア = 期待ロイヤリティ + FL期待価値 − ファウル率ペナルティ。FL価値（52枚:
  `DEFAULT_FL_VALUES` / ジョーカー入り: `DEFAULT_FL_VALUES_JOKER`、再計測は `flValueRate.test.ts`）と
  ファウルコスト（`DEFAULT_FOUL_WEIGHT`）はモンテカルロ実測から導出した値（solver.ts のコメント参照）。
  変更時は新旧の重みで同一配牌ペア比較（J = 対戦スコア + FL実測価値）を回して EV 改善を確認すること。

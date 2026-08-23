# 開発メモ（OFC Solver）

パイナップル OFC（Open Face Chinese poker）の実戦アシスタント / ソルバー。Vite + React + TypeScript。
重い計算は Web Worker で実行（MixMage と同じ流儀）。

## ビルド / 確認

- 本番ビルド: `pnpm build`（= `tsc -b && vite build`）。**push 前に必ず通す**。
- テスト: `pnpm test`（vitest、モンテカルロが重いので `--testTimeout=20000`）。
- UI を触ったらブラウザ（モバイル幅375px・デスクトップ）で実機確認する。横スクロールは最終手段。

## 作業の進め方

- **仕様・モデル設計は勝手に決めない**。評価モデル（futureModel）・評価式・重み・ルール解釈など、
  結果に影響する設計判断は、必ずユーザーと壁打ち（案と選択肢を出して合意）してから実装に移る。
  - 背景: 'streets' モデルの「配置は全部見てから最適」という割り切りは実ゲームと乖離しすぎている
    とユーザーが判断済み。この種の割り切りを独断で導入したことへの是正指示（2026-08）。
- **ツールの絶対的精度の評価は素点（自分のロイヤリティ合計、相手非依存）を使う**。
  対戦得点は相手モデルの強さに依存するため、構成間の相対比較にのみ用いる。
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
- **候補評価の未来モデル** (`evaluateBoard` の `futureModel`): 既定 `'combined'` = 逐次プレイ
  （トップは Q+ を到着順コミット + 残りは「各ストリート1枚捨て」制約下の最適配置、
  トップQQ+確定型は最適/素朴の品質ブレンド）で全統計を測る。FL価値はスケール補正なしの
  実測テーブル（同枚数維持リステイ）。参考ソルバー（=54枚デッキの逐次シミュレーションと
  FL内訳の一致で特定）のEV水準はこのテーブルで自然に再現される。`'policy'` = ブレンドなしの逐次。
  `'rollout'`（最高品質・最重量 = 精度「解析」）= 固定方針なしの逐次最適プレイ。各ストリートの
  全合法手を内側MC（候補間共通乱数、`rolloutInner`、解析は24）で採点して選ぶ。内側の末端モデルは
  `rolloutLeaf`（解析は `'policy'`。streets 末端は静的捨て+後知恵配置の保守バイアスでFLチェイス配置を
  過小評価し、KKハンドで参考#1を25位に沈めた。policy 末端で参考と順位一致、2026-08）。解析は初手も
  **粗選別なしの全候補直当て**（粗選別に streets を使うと後知恵バイアスで真の上位が精評価前に
  落ちるため。勉強用・時間無制限のユーザー合意設計、2026-08）。
  `'hindsight'`（捨て制約つき後知恵の到達上限、FL価値は `HINDSIGHT_FL_SCALE` 倍）/
  `'streets'`（捨てヒューリスティック+最適補完。実プレイ1,200ハンドのA/Bで検証済み）/
  `'exact'`（旧モデル）。モデル間のEV比較は `futureModelAB.test.ts`。FL種別内訳
  （QQ/KK/AA/3x）は `BoardMetric.flBreakdown` で UI に表示される。
- FL 継続率: `flStay.ts` の `stayFeasibility` がリステイ可能性を厳密判定（`solveFantasyland` との
  クロスチェックテストで担保）。継続率の再計測は `FL_STAY_ITERS=500000 pnpm vitest run src/domain/flStayRate.test.ts --testTimeout=3600000`。
- モンテカルロは決定論的 PRNG（`combinatorics.ts` の `mulberry32`）を注入してテストの再現性を確保する。
- **並列計算**: `src/worker/solverClient.ts` の Worker プールが候補集合をチャンク分割して実行する。
  分割の入口はドメイン側のチャンク API（`evaluateInitialChunk` / `evaluateStreetChunk`、
  FL は `solveFantasyland` の `bottomRange`、EV は `estimateEVvsRandomStats` のシード分割 +
  Chan の公式で統合）。**候補ごとに独立シードの PRNG を使うため分割不変**。この性質は
  `solverParallel.test.ts` で担保しているので、チャンク API を触ったら必ず維持・更新する。
- UI は実戦アシスタント（`App.tsx`）: プレイモード（初手→ストリート進行 + 推奨手）、
  対戦モード（vs ソルバー。ポジション制: OOP が先置き・IP は後追い、ハンドごとに交代。
  山札進行は `App.tsx` の進行ドライバ effect と `roundOf` の手番ゲート。ソルバーの情報は
  自身の手札/捨て札 + Hero の公開盤面のみに制限。FL 突入/リステイは vsPending*FL で次ハンドへ
  引き継ぎ、FL 側は一括配置・相手完成まで伏せ・手番ゲートなしの独立進行）、FL モード。
  Worker プロトコルは `solver.worker.ts`（evalInitialChunk / evalStreetChunk / solveFL / ev ほか）。
  設定・盤面は `persist.ts` が localStorage に自動保存（スキーマ変更時はキーの版数を上げる）。
  オフライン対応は `vite-plugin-pwa` の Service Worker（`vite.config.ts`）。

## 注意

- ロイヤリティ / FL 規則はルームによって差があるので、標準を実装しつつ差し替え可能にしている。
- **リステイ枚数ルール**: 本ルームは「リステイ後も同じ枚数を維持」（17枚FLでリステイ→また17枚）。
  FL価値は V(n)=Δ(n)/(1−pStay(n)) の同枚数連鎖で導出し、リステイボーナスは `stayBonusFor(n, jokers)`
  = V(現在のFL枚数)。標準ルール（リステイ→14枚）に切り替える場合は solver.ts のテーブルと
  flValueRate.test.ts の導出式を戻すこと。
- 推奨手のスコア = 期待ロイヤリティ + FL期待価値 − ファウル率ペナルティ。FL価値（52枚:
  `DEFAULT_FL_VALUES` / ジョーカー入り: `DEFAULT_FL_VALUES_JOKER`、再計測は `flValueRate.test.ts`）と
  ファウルコスト（`DEFAULT_FOUL_WEIGHT`）はモンテカルロ実測から導出した値（solver.ts のコメント参照）。
  変更時は新旧の重みで同一配牌ペア比較（J = 対戦スコア + FL実測価値）を回して EV 改善を確認すること。

# verify-tasks レポート

- 日付: 2026-11-19
- 範囲: `all`（基点 `origin/main` = `aed92771`、ブランチ `feat/admin-calendar-v2-switch` の HEAD と未コミット・未追跡の変更）
- 対象: T000 のみ（指定による。D001〜D004 は対象外）
- 件数: 1

> ⚠️ **FRESH SESSION ADVISORY**: 実装したのと同じセッションで実行した。実装者の文脈は自分の作業を認める方向に偏るため、別のセッションでの再実行が望ましい。

## 集計

| 判定 | 件数 |
| --- | --- |
| ✅ VERIFIED | 0 |
| 🔍 PARTIAL | 1 |
| ⚠️ WEAK | 0 |
| ❌ NOT_FOUND | 0 |
| ⏭️ SKIPPED | 0 |

## 指摘

### T000 — 🔍 PARTIAL

| 層 | 結果 | 根拠 |
| --- | --- | --- |
| 1 ファイルの存在 | positive | `src/bindings.ts`、`src/runtime-config.ts`、`admin-app/src/routes.tsx`、`wrangler.jsonc` がある。`.dev.vars` は Git 管理外の開発者の手元のファイルで、リポジトリには無いのが正しい |
| 2 差分との照合 | positive | `src/bindings.ts`、`src/runtime-config.ts`、`src/routes/admin-api.ts`、`admin-app/src/routes.tsx`、`admin-app/src/providers/auth-provider.tsx`、`admin-app/src/providers/auth-context.ts` が変更済み。`wrangler.jsonc` と `.env.example` は変えていない（タスクの指示どおり） |
| 3 記号の照合 | positive | `ADMIN_CALENDAR_V2_ENABLED`（`src/bindings.ts:65`、`src/runtime-config.ts:51`）、`isAdminCalendarV2Enabled`（`src/runtime-config.ts:48`）、`ScheduleRoute`（`admin-app/src/routes.tsx:33`）、`/me` の `calendarV2`（`src/routes/admin-api.ts:280`、`:307`） |
| 4 未使用コード | positive | `isAdminCalendarV2Enabled` は `/me` の 2 か所で使用。`ScheduleRoute` は index 経路で使用。`ScheduleV2Page` は lazy import で使用。`calendarV2` は `AuthProvider` が設定し `ScheduleRoute` が読む |
| 5 意味の評価 | negative | ⚠️ Interpretive: 配備側の部分が実装されていない。タスクは「値は配備側の設定で確認用環境にだけ置き、配備手順書に確認用限定として記載する」「止めるときは `"false"` を明示して配備する」と、試験「`"true"` と `"false"` のどちらも承認済みの配備経路と配備後の検証を通って確認用環境に届き、認証済みの `/me` に反映される」「明示の停止の後の通常の再配備でもオフ」「確認用環境の再配備でオンが保たれる」を含む。差分には配備側の設定・手順書・配備後の確認が一つも無い（このリポジトリには配備設定が無く、配備は別の運用側で行う）。サーバーの判定・`/me`・経路の選択・試験（本番に `"true"` が残る場合、`local` の有無、`/customers` への直接アクセス）は実装済み。予定表とカルテの往復は、オフでは今の `SchedulePage` をそのまま描くため既存テストに依拠しており、経路の試験では直接確かめていない |

## 確認済み

なし。

## 判定不能

なし。

## 判定一覧

| タスク | 判定 | 要約 |
| --- | --- | --- |
| T000 | 🔍 PARTIAL | サーバーの判定・/me・経路の選択・試験は実装済み。配備側の値の配置・手順書・停止と再配備の確認は未実施 |

## Walkthrough Log

| 項目 | 対応 | 結果 |
|---|---|---|
| T000 — 🔍 PARTIAL | 修正を提案（F）。オーナーが判断を委任（2026-11-19）。T000 を「判定と受け渡し（実装済み）」と「確認用環境で値を入れる作業（T000b、未着手）」に分けた。手元の既定値として `.env.example` に `ADMIN_CALENDAR_V2_ENABLED=false` を足した | 🔍 PARTIAL → 分割後の T000 は再検証で確かめる。T000b は T004・T005 の後 |

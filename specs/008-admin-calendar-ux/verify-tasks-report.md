# verify-tasks レポート

- 日付: 2026-11-19
- 範囲: `all`（基点 `origin/main` = `9449343a`、ブランチ `feat/admin-calendar-v2-switch` の HEAD = `920c6085`）
- 対象: T000 のみ（指定による。T000b は未完了のため対象外）
- 件数: 1

> ⚠️ **FRESH SESSION ADVISORY**: 実装したセッションとは別のエージェント（新しい文脈）で実行した。実装者の文脈は自分の作業を認める方向に偏るため、この形で取り直した。

同じ日の前回の実行（分割前の T000）は 🔍 PARTIAL だった。配備側の作業（確認用環境の値・手順書・停止と再配備の確認）が未実施だったためで、オーナーの委任を受けてその部分を T000b に分け、T000 を判定と受け渡しの範囲にしてから再実行した。

## 集計

| 判定 | 件数 |
| --- | --- |
| ✅ VERIFIED | 1 |
| 🔍 PARTIAL | 0 |
| ⚠️ WEAK | 0 |
| ❌ NOT_FOUND | 0 |
| ⏭️ SKIPPED | 0 |

## 指摘

なし。

## 確認済み

### T000 — ✅ VERIFIED

| 層 | 結果 | 根拠 |
| --- | --- | --- |
| 1 ファイルの存在 | positive | `src/bindings.ts`、`src/runtime-config.ts`、`src/routes/admin-api.ts`、`admin-app/src/routes.tsx`、`.env.example`、`wrangler.jsonc`、`test/admin-calendar-v2-switch.test.ts`、`admin-app/src/routes.test.tsx` がある。`.dev.vars` は Git 管理外（`.gitignore` の `.dev.vars*`）の手元のファイルで、リポジトリに無いのが正しい |
| 2 差分との照合 | positive | 上のファイルのうち `wrangler.jsonc` 以外が `9449343..920c608` の変更一覧に入っている |
| 3 記号の照合 | positive | `ADMIN_CALENDAR_V2_ENABLED` は型（`src/bindings.ts:64-65`）と手元の既定値（`.env.example:45-46`）にあり、`wrangler.jsonc` には無い（欠落はオフ）。判定は `src/runtime-config.ts:48-52`。`/me` は手元用と認証済みの両方の応答で `calendarV2` を返す（`src/routes/admin-api.ts:280`、`:307`）。`ScheduleRoute` は `admin-app/src/routes.tsx:33-34` で、外枠の選択は変えていない |
| 4 未使用コード | positive | `isAdminCalendarV2Enabled` は `/me` の 2 か所で使用。`ScheduleRoute` は index 経路、`ScheduleV2Page` は `ScheduleRoute` から使用。`calendarV2` は `AuthProvider` が設定し `ScheduleRoute` が読む |
| 5 意味の評価 | positive | ⚠️ Interpretive: サーバーの試験は `staging` と `local` で `"true"` のときだけオン、`"false"`・欠落・`"TRUE"`・本番の `"true"`・`ENVIRONMENT` の欠落でオフを確かめる。管理画面の試験は欠落・`false`・文字列 `"true"` でオフ、`true` でオン、`/customers` への直接アクセスが今の外枠、予定表とカルテの往復で外枠が作り直されず今の予定表に戻ることを確かめる。往復の遷移の引数と状態の復元は、タスクの記述どおり `admin-app/src/pages/schedule.test.tsx` の既存テストが受け持つ。新しい予定表のページは設計上の仮置きで、T000 が約束するのは選ぶ経路だけ |

試験が判定の誤りで失敗することは、変異で確かめた（外枠が遷移のたびに作り直される、`AuthProvider` が真の値を広く受け入れる、サーバーが `ENVIRONMENT` を見ない、値の大文字小文字を区別しない、の 4 通りで、それぞれ該当の試験が失敗した）。

## 判定不能

なし。

## 判定一覧

| タスク | 判定 | 要約 |
| --- | --- | --- |
| T000 | ✅ VERIFIED | 判定・/me・経路の選択・手元の既定値・試験（往復を含む）は実装済み。配備側の作業は T000b |

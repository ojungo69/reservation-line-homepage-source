# ADR 0001 予約変更の保存結果が分からないときの確定方法

決定日 2026-11-22。対象は T003。実装は T008〜T010 と T013 で行う。

## 背景

[予約変更契約の第6章](contracts/reservation-interactions.md#6-応答喪失replay結果不明)では、commit の応答を失った場合に元の操作の結果を確定する方法を定める。必要なのは、元の結果を正しく表示し、未保存と確定した操作を後から適用できなくすることだ。UX-17〜20 は、版を条件とする保存、同じキーでの照合、保存済みの版を条件とする逆変更、DB 保存と LINE・Google の非同期処理の区別を求める（`spec.md:87–90`）。サーバーを先に追加し、旧書込への自動切替を防ぐ。停止時は送信中・結果不明の画面を保持し、再読み込みでは照合を引き継がない（`plan.md:20–32,58–66,76–84`）。

2026-11-22 のオーナー判断に従う。応答を失ったら「保存できたか確認できていません」と表示する。自動で元に戻したり、送り直したり、再確認したりしない。「確認する」を押したときだけ同じ内容で照合し、「保存済み」か「保存されていない（この後も保存されない）」を示す。照合によってお客様への LINE を重ねて送らない。照合できるのはその画面を開いている間で、最長24時間とする。開き直したときは最新の予約で確かめる。停止中に結果が分からない場合は、最新の予約を見て閉じられるようにし、新しい変更を始められないようにする。

## 調査結果

- **旧APIの利用元。** 新旧の予定表、予約一覧、顧客詳細は共有の `ReservationDetailPanel` を使う（`admin-app/src/pages/schedule-v2.tsx:377–396`、`admin-app/src/pages/schedule.tsx:288–300`、`admin-app/src/pages/reservations.tsx:760`、`admin-app/src/components/customers/customer-detail-panel.tsx:1373`）。パネルが開く開始時刻変更・長さ変更の両ダイアログは、`useRescheduleReservation` から旧 `POST /api/admin/reservations/:id/reschedule` に送る（`admin-app/src/components/schedule/reservation-detail-panel.tsx:652–684,813–820`、`admin-app/src/components/schedule/reservation-reschedule-dialog.tsx:34–42,188–202`、`admin-app/src/components/schedule/reservation-duration-dialog.tsx:41–45,111–129`、`admin-app/src/hooks/use-reservations.ts:247–268`）。サーバーのparserは `expectedVersion` を読まない（`src/routes/admin-api.ts:419–448,3232–3250`）。リポジトリ外の利用元は未確認。
- **予約version。** `reservations.version` の初期値は1。旧APIも版を進め、batch内で書込後の版を確認する（`migrations/0001_initial.sql:176`、`src/reservations/transitions.ts:245–256`、`src/admin/reservation-reschedule.ts:157–182,438–487`）。詳細と承認待ち一覧は版を返す。日付別一覧はSQLで版を取得するが、応答への変換で省く（`src/admin/operations.ts:634–653,708,791–808,1337–1349`、`src/admin/reservations.ts:1352–1358,1369–1383`、`admin-app/src/types/api.ts:1–31,182–206`）。新フォームは詳細の版を使う。日付別一覧から版を使う場合は応答とフロントの型に項目を足す（[調査の詳細](research.md#6-t003-旧apiの利用元と予約version)）。
- **旧APIの結果確認。** 状態と営業時間などの検証後に、旧APIの24時間TTL内でキーとhashを照合する。成功のreplayは予約の現在行を読む。適用時の値や未適用の確定は保管しない（`src/admin/settings-common.ts:11`、`src/admin/reservation-reschedule.ts:215–246,362–390,617–669`）。
- **読み取り経路。** D1 Sessionsが有効なとき、ミドルウェアはパス別の方針または既定の `first-unconstrained` を使う。後者の経路で有効な長さのbookmarkが来ればそれを使い、セッションを `readDb` に置く（`src/middleware/d1-session.ts:3–7,11–38`）。照合で使う現在の状態は規則6に従って主DBから読む。

## 決定 (b) 照合時に未適用を確定し、後からのcommitを防ぐ

「確認する」は `POST /api/admin/reservations/:id/reschedule/commit?mode=check` に元と同じキー・正規化済み入力を送る。`mode` は要求hashに含めない。成功時は適用前後・適用版を固定した結果と現時点の予約を返す。確定した未適用は `operation_not_applied` を返す。

### 不変条件

1. **通常commitの原子性。** 予約の変更と操作行の `succeeded` への遷移を同じD1 batchに置く。batchは1つのSQL取引で、1文の失敗で全体が戻る。予約UPDATEの `WHERE` に `version = expectedVersion` と、自分が確保した同じキー・hashの `started` 行の `EXISTS` を置く。続くロック・履歴・LINE・Googleジョブ・成功記録の書込は、予約が `expectedVersion + 1` で、このbatchが付けた操作の印がある場合だけ進める。現行の `guardRescheduleTransitionApplied` も直後の行数と版・操作者等の `EXISTS` を組み合わせている（`src/admin/reservation-reschedule.ts:143–182`）。新経路では予約UPDATEの直後に、1行更新と新しい版を条件にbatch固有のIDで変更履歴を挿入し、その監査行を操作の印に使う。認可guardはその前に置く（`src/admin/write-authorization.ts:16–25`、`src/admin/reservation-reschedule.ts:543–555`、`migrations/0001_initial.sql:508–517`）。後続文は版と印の `EXISTS` を使う。LINE連携がなければ通知INSERTは0行が正しいため、直前の `changes()` だけを連鎖させない。予約UPDATEが0行なら後続文も何も書かない。0行UPDATEでbatchは失敗しないため、条件は最後の文だけに置かない。batchの最後には、予約がこの操作の新しい版になったのに操作行が `succeeded` でない（または印の履歴行が無い）ときにSQLのエラーを起こす確認の文を置き、取引ごと戻す。これにより、確定したbatchでは予約の更新・付随の書込・`succeeded` への遷移が必ずそろう。 [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
2. **照合とcommitの順序。** 同じD1データベースは問い合わせを1つずつ処理する。照合の単独のUPDATE（`status = 'started'` と同じキー・hashを条件に `not_applied` へ進める）はcommitのbatchの前か後に入る。前なら規則1によりbatchは何も書かない。後なら操作行は `succeeded` なので照合のUPDATEは0行になり、読み直して保存済みを返す。 [D1の並行処理](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput)
3. **未適用の確定。** `not_applied` を書けるのは、(i) 切り替えがオンの照合で、行がなければ競合を検出するINSERT、`started` なら同じキー・hashを条件にするUPDATEを行う場合と、(ii) 自分のcommitでbatchの結果を受け取り、予約UPDATEが条件不一致で0行だったため全書込がなかったと分かり、自分の行を `status = 'started'` を条件に更新する場合だけ。予約UPDATEが0行だったcommitは成功を返さない。条件付き書込が競合したら主DBで読み直し、確定した行に従う。batch呼出しの結果が通信失敗などで分からなければ、操作行に新たな書込をせず結果不明を返す。
4. **操作行の保持。** 操作行が消えるのは対象予約を削除したときの `ON DELETE CASCADE` だけ。結果の列も保持する。対象予約が存在し、主DBに同じ操作者・キーの行がなければ、そのキーの保存はまだ確定していない。照合で未適用の書込を確定させてから未保存と答える。通常は変更1回につき小さな1行が増える。行は操作者ごとに分かれる。別の操作者が同じキーで照合しても、その人の行として扱われ、元の操作者の行・commit・照合には影響しない（キーは端末が操作ごとに作る乱数で、共有しない）。
5. **画面の照合期間。** サーバーは新契約の操作受付・照合結果の判定に時計を使わない。`created_at`・`updated_at` は記録専用とする。画面は最初のcommitを送るときの `performance.now()` から経過時間を測る。24時間に達したら「確認する」を終了し、最新の予約の確認へ案内する。照合、日付変更、停止と再有効化で計測を始め直さない。開き直し・再読み込み・認証主体の切替では引き継がない。サーバーは画面の期間を過ぎた照合にも保存状態に従って答える。通常の予約変更に適用する営業時間等の業務条件は第3章・第4章に従う。
6. **主DB。** 判断に使う読み書きは `env.DB` を使う。Sessions API経由の `readDb` は既定の `first-unconstrained` で複製を読む場合があるため、操作結果・現在の権限・version等の判定には使わない（`src/middleware/d1-session.ts:19–38`）。結果不明の後に最新の予約を読むとき（照合を閉じた後、24時間の後、開き直した後）も `env.DB` から読む。いまは `wrangler.jsonc` の `D1_SESSION_ENABLED` が `"false"` で、`readDb` を使う経路も無い。 [D1のセッションと読み取り先](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession)
7. **照合の検査範囲。** `mode=check` は認証、現在の店舗・操作権限、要求の形、回数制限を確認する。操作行の条件付きINSERT・UPDATEにも現在の権限と対象予約の店舗の条件を置く。予約やロック・履歴・LINE・Googleジョブを書き換えず、予約の版や空き枠の業務検査を通さない。元の保存後に予約が更新されても照合できる。
8. **変更を戻す。** T013は `succeeded` と読めた操作だけを対象にし、同じ予約の元操作と現在の版を第8章の条件で確認する。`started`・`not_applied`・結果不明の操作では最新の予約を表示する。

### 通常commitと停止

認証・認可と入力検査の後、既存の操作行と切り替えを確認する。オンの新しい通常commitは業務条件を検証し、現在の予約とintentから `previewFingerprint` を計算し直す。検証中に版の不一致に気づいたら、拒否の前に同じキーを主DBで再読取し、同じhashで成功済みならreplayする。新規操作は `started` を `INSERT … ON CONFLICT DO NOTHING` で確保する。衝突したら行を再読取し、別hashは `idempotency_conflict`、同じhashは `succeeded` ならreplay、`not_applied` なら `operation_not_applied`、`started` なら `idempotency_in_progress` とする。確保した要求だけが規則1のbatchへ進む。

オフの通常commit・照合は既存の行からreplay・`idempotency_conflict`・`idempotency_in_progress` を返す。それ以外は予約・ロック・履歴・ジョブ・冪等記録を書き込まず `feature_disabled` を返す。previewは現在の認可の後に `feature_disabled` を返す。停止前に受け付けた元の要求は後から確定し得るため、停止の応答だけでは結果は分からない。停止中は新しい変更を始めず、結果が分からないまま最新の予約を見て閉じられる。画面の照合期間中は停止・再有効化のいずれでも手動照合を使う。

## 保存の形

新表は `reservation_change_operations` の1つとする。既存の `idempotency_keys` はscope・statusが `CHECK` で制約されている（`migrations/0001_initial.sql:288–300`）。Worker変更と別のPRで、新表と索引だけを先に入れる。

| 列 | 型・制約 |
| --- | --- |
| `operation_id` | `TEXT NOT NULL PRIMARY KEY`。サーバーが生成し、Undoで成功済み操作を参照する |
| `reservation_id` | `TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE` |
| `actor_id`, `idempotency_key` | `TEXT NOT NULL`、`UNIQUE (actor_id, idempotency_key)`。操作者は認証済みの管理者ID |
| `request_hash` | `TEXT NOT NULL`。SHA-256の16進表記64文字 |
| `kind`, `inverse_of_operation_id` | `kind` は `TEXT NOT NULL`、`CHECK` で `move`・`resize`・`undo`。参照は `TEXT` で、`undo` のときだけ非NULL |
| `status` | `TEXT NOT NULL`、`CHECK` で `started`・`succeeded`・`not_applied`。成功と未適用は終端 |
| `created_at`, `updated_at` | `TEXT NOT NULL`。UTC時刻を記録する |
| `before_version`, `applied_version` | `INTEGER`。成功時は正の安全な整数で `applied_version = before_version + 1` |
| `before_snapshot_json`, `after_snapshot_json` | `TEXT`。開始、施術終了、清掃込み終了、占有分数、施術分数のJSONオブジェクト。旧予約の占有5分も保存する |
| `effects_json` | `TEXT`。LINEジョブ作成の有無・理由と作成したジョブID、Google upsertジョブIDのJSONオブジェクト |

`succeeded` のときだけ前後の版・前後のJSON・`effects_json` をすべて非NULLとし、それ以外はすべてNULLとする `CHECK` を置く。主キー・一意制約に加え `(reservation_id)` に索引を置く。予約の削除はD1が強制する外部キーで連動し、現行の顧客削除で予約を物理削除できる（`src/admin/customer-delete.ts:11–24,350–354`）。外部キーは予約にだけ設定する。Undoの参照先は書込時に同じ予約の成功行かを確認する。顧客名・連絡先・通知本文は写さない。 [D1の外部キー](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)

新キーは `calendar-v1:<UUID>:<previewFingerprint の SHA-256>` とし、クライアントが確定操作ごとに一度作る。別の照合値との組み合わせはキーの確保前に拒否する。照合値は予約の版・正規化したintent・変更前後・通知などの確認内容から算出する。要求hashには契約識別子、予約ID、`expectedVersion`、正規化したintent、`previewFingerprint` を入れる。旧経路は既存の `admin_action` と旧hashを使い、開始移動では予約ID・正規化した開始時刻、長さ指定時は清掃込みの `durationMinutes` を加える（`src/admin/reservation-reschedule.ts:117–140,365–374,463–474`）。新旧の行は別々に引く。

同じ変更の通知・同期ジョブは再作成しない。旧経路と同じ予約ID・適用版によるジョブの重複防止と、通知ジョブIDを使うLINEの再試行を維持する（`src/admin/reservation-reschedule.ts:489–539`、`src/line/notifications.ts:1276–1305`）。

## 互換導入順

このADRと受入条件のレビュー後、新表と索引のmigrationを先に入れ、既存Workerの読取・保存・予約削除を確かめる。次に旧URI・旧hash・TTL内のreplayを保ち、詳細の版を使うpreview・commit・照合を追加する。T010は新予定表から開いたフォームだけを切り替える。フォームの検証後に直接操作を有効にし、成功行の参照・版条件・再通知の検証後にUndoを有効にする。旧経路の廃止前にリポジトリ外の利用状況も確認する。

## 採らなかった案

- **(a) previewの期限で確定する。** 期限まで待つ必要があり、検証済みの書込が残っていれば期限だけでは未適用を確定できない。
- **(c) previewとサーバー発行の操作キーを結び付ける。** キーを先に束縛しても、遅延した書込を防ぐ終端状態が要る。確定と照合で同じ一意キーを使う。
- **照合値の署名。** 新しい秘密の値が必要になる。この用途の鍵は `.env.example` に無い。新しいcommitは現在の予約とintentから照合値を計算し直す。
- **2つの時計の比較。** 別のisolateの時計が数秒ずれるだけで正しい保存を拒み得る。操作行と結果を予約の削除まで保持すれば、時計なしで確定結果を答えられる。

## 結果と残る制限

保存と未適用の確定はどちらか一方だけが成立する。予約が残る間は新表に操作行が残る。停止、権限の喪失や通信・DB障害で照合できない場合は、最新の予約を確認して閉じられる。後で別の変更を始める場合、新画面は取得し直した版を使う。旧画面からの手動変更には画面が読んだ版の条件がない。旧経路は予約の更新が0行でも通知・同期のジョブを書く。同じ版の重なりは `dedupe_key` で防げるが、別の種類の変更（承認など）が同時に版を進めた場合は、その版の時間変更の通知が作られる。送り手は時間変更の通知では予約の状態だけを確かめ、版を確かめない（`src/line/notifications.ts:913–914`）ので、その通知は送られ得る。これは今の旧経路の性質で、新経路は不変条件1で後続の文を予約の更新に繋ぐので起きない。版の一致だけでは、承認などが同じ版へ先に進めた場合を見分けられない。直しは T009 で行い、旧経路の通知・同期のジョブの INSERT を、新経路と同じく予約の更新に繋ぐ（`guardRescheduleTransitionApplied` と同じ `EXISTS`）。負けた旧経路の要求はジョブを書かない。

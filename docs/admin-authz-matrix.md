# Admin API 認可マトリクス

`/api/admin/*` の各エンドポイントについて role × data scope × server-side ガード位置を表にした、認可の正本ドキュメント。「frontend で button を hide するだけに頼らず、server 側 (各 service 関数の最初の guard) で誰が何をできるかを確認する」ための参照。元々は Phase 0b の実装ガイドとして作られたが、現在は実装済みエンドポイントの**現状の認可を記録する生きたドキュメント**として保守する（下記の予約系の「Phase 0b 作業」列など一部に当時の作業計画が残るが、ガード自体は実装済み）。

> 2026-06-08 更新: 設定 (settings) / 店舗ログイン (store-logins, #308) / LINE友だち (line-friends, #291-292) の write 系 約19操作を追記し、旧「Phase 4 で write 系を追加時に owner+ ガード」という将来形を実装済みの現在形に置き換えた。
>
> 2026-08-09 更新: `createApp()` の登録ルートと本表の突合テスト (`test/admin-authz-matrix-sync.test.ts`) を追加し、未記載エンドポイントの追記・幽霊記載の削除・`POST/PUT/DELETE` 略記の行分割を実施した。
>
> 2026-08-26 更新: 顧客の手動登録・アーカイブ/復元・ブロック/解除を staff に開放し、店舗スコープの定義に `customers.created_store_id` を足した (specs/006)。⚠️ 突合テストはエンドポイント集合しか見ておらず role 列も前文も検査しないので、認可の変更はレビューで本表の更新を確認すること。
>
> 2026-08-30 更新: 顧客タブにオーナー承認のワンタイムコード・ゲートを追加した (specs/008)。staff は店舗スコープに**加えて**、オーナー宛メールに届く 6 桁コードを検証して得た 12 時間の承認を持たない限り顧客系 API を通れない。owner / system_admin は対象外。

## Role 定義

| role | 想定ユーザ | アクセス対象 |
|---|---|---|
| `staff` | 店舗スタッフ (iPad) | 自店舗の予約業務 (全期間 readonly + 承認/却下/完了/no-show/来店なし訂正/キャンセル/reschedule)。日付制限なし・店舗 scope のみ (2026-07-14 当日ガード撤廃) |
| `owner` | オーナー | 全店舗 / 全期間 / 設定編集 |
| `system_admin` | 開発者 | owner + audit metadata 完全表示 + 同期障害対応 |

`AdminUser.role` を `src/admin/access.ts:authenticateAdmin` で Cloudflare Access JWT から取得 (現状)。今後 (Phase 0b 以降) 全 endpoint で **frontend hide のみ** に依存せず **data layer (各 service 関数の最初の guard)** で role を判定すること。

## 認可マトリクス

2026-09-12 (specs/012): 顧客block/unblock/archive/unarchive/統合/完全削除、共通予約7アクション、設定20操作では、書込と同じD1 batch内でactorのactive・role・staff所属・店舗を再照合する。失効が先に確定した場合は部分書込を残さず、現在も失効していれば既存の403へ対応付ける。直後に同一権限へ復帰していれば既存競合エラーとなる場合がある。設定の早期昇格拒否監査も同じactor条件で書く。この時点の対象一覧は このマトリクスの該当操作。


2026-09-14: PR #704のプロフィールに続き、顧客メモ・来店施術メモ・手動顧客登録・手動来店追加/編集/削除・予約作成/日時変更・キャンセル料未納変更の9操作にも同じactor検査を適用。顧客メモは更新時の3条件の店舗紐付け、来店メモは現在の来店店舗と有効/非archive/非merge状態、予約作成の既存顧客再利用は予約INSERT前のcanonical状態と店舗紐付けを確認する。新予約自身で所属を作って権限検査を通すことはできない。日時変更は対象店舗を保持し、キャンセル料は更新時にもstaffの店舗を照合する。権限失効では全batchをrollbackする。既に成功した冪等リプレイの契約は変更しない。

2026-09-29 (specs/015): #664の残19ルート（同期・競合解消・外部ブロック・LINE友だち・顧客タブ承認・push・繰り返し作成・管理起動auto-complete）にも同じ書込時actor検査を適用する。claim、分割batch、最終監査も対象にし、権限失効後の新たな業務副作用を拒否する。失効前に完了した部分成功は保持し、自分が取得したclaimの解除や発行したchallengeの補償は失効後も行う。外部メール／push／provider読取は直前に最新actorを検査するが、DB検査と外部APIを原子的にはできないため、その間の失効raceまで消える保証ではない。Cron共有処理は管理起動時だけactorを渡し、自律処理を維持する。共通rate-limit、last_seen_at、staging診断をこの業務書込保証へ暗黙に含めない。詳細は このマトリクスの該当操作 を参照。

凡例:
- ✅ 既存 server-side ガードあり (data layer or handler)
- ⚠️ 既存 server-side ガード不在 (Phase 0b で追加必要)
- ❌ アクセス不可
- 📅 スコープ制約 (当日 only 等)
- `n/a` 該当しない

### セッション / 自己情報

| Endpoint | staff | owner | system_admin | 既存ガード位置 |
|---|---|---|---|---|
| `GET /api/admin/me` | ✅ 自分の email / role / staffMemberId / storeId と VAPID 公開鍵のみ | ✅ | ✅ | `authenticateAdmin` (access.ts)。role 分岐なし。local 環境は dev owner を返す。認可ゲートというより SPA のセッション確認用 |

### 予約 (reservations)

| Endpoint | staff | owner | system_admin | 既存ガード位置 | Phase 0b 作業 |
|---|---|---|---|---|---|
| `POST /api/admin/reservations` (手動予約) | ✅ 自店舗のみ作成可。`customerId` 指定は `staffCanAccessCustomer` を満たす自店舗スコープ顧客のみ (store 未紐付けは fail-closed 403) | ✅ 全店舗。既存 `customerId` は canonical (未アーカイブ・未統合) のみ、blocked は `customer_blocked` (role 共通の状態除外) | ✅ | `createAdminReservation` — staff store gate + customerId は `staffCanAccessCustomer` (customers.ts)。2026-07-19 staff rebook 対応: 旧「staff + customerId = 無条件 403」を自店舗スコープ判定へ緩和 (電話番号マスクのため customerId が staff 唯一の既存客予約経路)。2026-07-22 管理画面の予約作成パネルの既存顧客検索を staff にも開放 (UI のみの変更・サーバー側ガード不変。検索結果は `GET /customers?q=` と同じ自店舗スコープ + 電話マスク) | ✅ 2026-07-22 更新 |
| `GET /api/admin/reservations/pending` | ✅ 自店舗・全期間 | ✅ 全期間 | ✅ | `listPendingReservations` の staff store scope (SQL レベル)。2026-07-04 全予約承認制で staff の当日 clamp を撤廃 — 承認待ち一覧は承認業務のキューであり将来日 pending が見えないと staff が承認/却下を担えない | ✅ 2026-07-04 更新 |
| `GET /api/admin/reservations` | ✅ 自店舗・全期間 | ✅ 全期間 | ✅ | `listAdminReservations` の staff store scope (SQL レベル)。2026-07-14 に当日 clamp を撤廃 — スケジュール画面で staff も前日/翌日/週を閲覧できるよう、要求日をそのまま解決する (旧: 当日へ強制し `staff_date_locked` notice を返していた) | ✅ 2026-07-14 更新 |
| `GET /api/admin/reservations/search` | ✅ 自店舗・期間検索 | ✅ 全店舗・期間検索 | ✅ | `prepareAdminPeriodHandler` → `listAdminReservationsForPeriod` (operations.ts)。staff は `isStaff` で自店舗へ絞る | ✅ 2026-08-09 追記 |
| `GET /api/admin/reservations/export.csv` | ✅ 自店舗・期間 CSV | ✅ 全店舗・期間 CSV | ✅ | `prepareAdminPeriodHandler` (`allowServiceToken: true`) → `listAdminReservationsForPeriod`。staff は `isStaff` で自店舗へ絞る。サービス帳票トークンは **staging 限定**（`access.ts` が `ENVIRONMENT !== "staging"` と `STAGING_SERVICE_TOKEN_AUTH !== "true"` の両方で拒否するため、本番では JWT のみ） | ✅ 2026-08-09 追記 |
| `GET /api/admin/reservations/available-slots` | ✅ 自店舗のみ (`storeId` 照合) | ✅ | ✅ | route で staff の `store_id !== storeId` を 403 (admin-api.ts)。空き枠は `getAvailableSlots` | ✅ 2026-08-09 追記 |
| `GET /api/admin/reservations/unpaid-cancellation-fees` | ✅ 自店舗・日付制限なし | ✅ 全店舗（絞り込みパラメータは無い。route はクエリを読まず `listUnpaidCancellationFees({db, admin})` を呼ぶだけ） | ✅ | `listUnpaidCancellationFees` の `resolveListStoreScope` (reservations.ts)。未納回収キューのため staff も自店舗全期間を見る | ✅ 2026-08-09 追記 |
| `GET /api/admin/reservations/:id` | ✅ 自店舗のみ (全期間・詳細 redaction) | ✅ | ✅ | `getAdminReservationDetail` (operations.ts) が staff を fail-closed で限定: store 未紐付けはクエリ実行前に即 `forbidden`、他店舗判定は store_id のみの最小照会で行い、PII を含む本照会 (reservationSelect / 顧客メモ) は scope 通過後にのみ実行 (本照会にも store_id 条件を再適用し TOCTOU を封じる)。route は 403 にマップするだけ。role 別 redaction (audit/notification/calendar/phone)。日付制限なし。2026-08-30 追加: 同じ顧客の直近の施術メモ 3 件 (`customerPastNotes`) も返す — staff には自店舗で記録された分だけ (`store_id` 条件は顧客履歴クエリと同じ) | ✅ 2026-08-30 更新 |
| `POST /api/admin/reservations/:id/approve` | ✅ 自店舗のみ (時間制約なし) | ✅ | ✅ | `validateAdminActionAuthorization` の store scope (reservations.ts)。日付制限なし: 承認対象は将来日の予約が本質 | ✅ 実装済み (PR#384) |
| `POST /api/admin/reservations/:id/reject` | ✅ 自店舗のみ (時間制約なし) | ✅ | ✅ | `validateAdminActionAuthorization` の store scope (reservations.ts)。対象は `pending_approval` のみ (確定済み予約には作用しない) | ✅ 2026-07-04 更新 |
| `POST /api/admin/reservations/:id/cancel` | ✅ 自店舗のみ (全期間) | ✅ | ✅ | `validateAdminActionAuthorization` の store scope。2026-07-14 に当日ガード撤廃 | ✅ 2026-07-14 更新 |
| `POST /api/admin/reservations/:id/complete` | ✅ 自店舗のみ (全期間) | ✅ | ✅ | 同上 | ✅ 2026-07-14 更新 |
| `POST /api/admin/reservations/:id/no-show` | ✅ 自店舗のみ (全期間) | ✅ | ✅ | 同上 | ✅ 2026-07-14 更新 |
| `POST /api/admin/reservations/:id/correct-no-show` | ✅ 自店舗のみ・顧客タブ承認不要 | ✅ | ✅ | `authenticateAdminWithDb` + `validateAdminActionAuthorization` の店舗照合を冪等 replay より先に実施。所属店舗なしは 403 | ✅ 2026-09-12 staff 開放 |
| `POST /api/admin/reservations/:id/restore-completed` | ❌ 403 | ✅ | ✅ | `requireOwnerWithDb` (認証直後・body 読取前) + `validateCorrectionRole` でも owner+ を再確認 | ✅ 2026-08-25 追加 |
| `POST /api/admin/reservations/:id/reschedule` | ✅ 自店舗のみ (全期間) | ✅ | ✅ | `rescheduleAdminReservation` の store scope (reservation-reschedule.ts)。2026-07-14 に当日ガード撤廃。新スロットは `listRescheduleAvailability` の営業時間/空き判定を通す | ✅ 2026-07-14 更新 |
| `PUT /api/admin/reservations/:id/cancellation-fee` | ✅ 自店舗のみ | ✅ | ✅ | route で `isAdminPrivileged` 以外は `store_id` 照合 (admin-api.ts)。no_show 時の未納フラグ set/clear。version は増やさない | ✅ 2026-08-09 追記 |
| `POST /api/admin/reservations/auto-complete-overdue` | ❌ | ✅ | ✅ | `authenticateAdminWithDb` + `requireOwnerWithDb` (admin-api.ts)。期限超過の確定予約を一括完了する backfill (`autoCompleteReservations` graceMs=0)。日次 cron と同一の副作用・冪等・全店舗横断のため owner 限定 | ✅ 2026-07-21 追加 |

### 顧客 (customers)

スタッフは「自店舗の顧客のみ」閲覧・編集できる（自店舗 = その顧客が **自店舗に予約** を持つ OR **`status='valid'` の来店記録**を1件以上持つ OR **自店舗が手動登録した** (`customers.created_store_id`)）。顧客テーブルは store_id を持たない GLOBAL エンティティのため、店舗紐付けはこの 3 条件で判定する（`staffCanAccessCustomer` / `storeScopeMembership`、customers.ts。3 条件は `STORE_MEMBERSHIP_UNION` の 3 本の arm と 1:1）。

2026-08-26 (specs/006) にスタッフへ開放した範囲: **手動登録・アーカイブ/復元・ブロック/解除**、およびその前提となる**アーカイブ済み一覧の閲覧**と**アーカイブ済み自店舗顧客の詳細閲覧**。**統合・完全削除・来店記録の手動追加/編集/削除は引き続きオーナー限定**。注意点を 3 つ:

- `created_store_id` を書くのは手動登録経路だけ。値は**認証情報 (`admin.store_id`) からのみ**取り、リクエストボディからは受け取らない。owner / system_admin の登録では NULL のまま
- アーカイブ済み顧客は**全ロールで読み取り専用**（メモ / プロフィール / 施術メモ / 来店追加の各 API が `archived_at IS NULL` を要求する）。読める範囲だけを `includeArchived` で広げている
- ブロックとアーカイブは**全店舗共通の状態**。1 店舗のスタッフの操作が他店舗にも及ぶ（オーナーが付けたブロックをスタッフが解除できることを含む）。実行者の店舗は audit metadata の `adminStoreId` に残す

> **顧客タブのオーナー承認ゲート (specs/008)**: 下表で「✅ 承認要」と書いた行は、staff の場合に店舗スコープに加えて有効な承認 (`admin_customer_gate_challenges.granted_until > now`) を要求する。承認が無ければ 403 `customer_gate_required`。ガードは `assertCustomerTabGate` (shared.ts) を各ハンドラの認証直後にインラインで呼ぶ形で、パススコープのミドルウェアは使わない (`/customers/*` は予約詳細パネルが使う共有ルートまで巻き込むため)。owner / system_admin は素通り。**予約詳細パネルに表示される顧客情報 (`GET /api/admin/reservations/:id`) は対象外** — オーナーの明示判断で、表示だけは承認なしでも見える。ただしカルテの**書き込み**は対象内。

| Endpoint | staff | owner | system_admin | ガード位置 |
|---|---|---|---|---|
| `POST /api/admin/customer-gate/request` | ✅ 承認コードの発行を要求する。60 秒に 1 回・1 時間 10 回まで | ❌ 400 `not_applicable` | ❌ 400 `not_applicable` | `authenticateAdminWithDb` → `requestCustomerGateCode` (customer-gate.ts)。コードはオーナー宛メールにのみ出て、応答本文には含まれない |
| `POST /api/admin/customer-gate/verify` | ✅ 6 桁コードを検証し 12 時間の承認を得る。15 分に 10 回まで | ❌ 400 `not_applicable` | ❌ 400 `not_applicable` | `authenticateAdminWithDb` → `verifyCustomerGateCode` (customer-gate.ts)。試行加算・照合・承認付与の UPDATE と、結果に応じた監査 INSERT 2 本を 1 つの `db.batch` (D1 では単一トランザクション) で流す |
| `GET /api/admin/customers?q=...` (検索) | ✅ 自店舗顧客のみ。**承認が無いときは `memo` を `null` に落として返す** (403 にしない) | ✅ 全顧客 | ✅ | `searchAdminCustomers(storeScope)` で staff を自店舗 membership に限定 (customers.ts)。承認の有無で `redactMemo` を決めるのはサーバー側 (admin-api.ts)。予約作成の顧客ピッカーが同じ URL を叩くため止めない (LINE 友だち紐付けも同じ URL だが `isAdminPrivileged` の owner 以上限定なので staff には関係しない)。氏名とマスク電話は `GET /reservations/search?keyword=` が元から返す範囲と同じ |
| `GET /api/admin/customers?mode=list` (一覧) | ✅ 承認要・自店舗顧客のみ・集計値も自店舗のみ | ✅ 全顧客 | ✅ | `listAllCustomers(storeScope)` で行集合・visitCount/lastVisitAt/nextReservationAt を自店舗 scope (customers.ts) |
| `GET /api/admin/customers?view=archived` | ✅ 承認要・自店舗のアーカイブ済み顧客のみ | ✅ | ✅ | `listAllCustomers(storeScope)` の membership 句がそのまま効く。2026-08-26 に staff 403 を撤去 (復元の導線がここにしか無いため) |
| `GET /api/admin/customers/:id` (詳細) | ✅ 承認要・自店舗顧客のみ・来店/予約履歴も自店舗のみ。**アーカイブ済みの自店舗顧客も可** (復元用・読み取りのみ)。統合元 (merge tombstone) と対象外は 403 (forbidden) | ✅ 全顧客 (アーカイブ/統合元含む) | ✅ | `getAdminCustomerDetail(admin)` で staff store-scope gate (`includeArchived: true`) + visits/reservations を自店舗 filter (operations.ts)。顧客 SELECT の staff 条件は `merged_into_id IS NULL` のみ。**2026-08-31 に顧客のメールアドレスを撤去した**ので、この応答に email は含まれない (role 別の redaction も無くなった) |
| `POST /api/admin/customers` (手動顧客登録) | ✅ 承認要・自店舗の顧客として登録 (`created_store_id = admin.store_id`)。店舗紐付けの無い staff は 403 | ✅ `created_store_id` は NULL | ✅ | `authenticateAdminWithDb` + `parseJsonObjectBody` → `createAdminCustomer` (customer-create.ts) で role 判定。紙カルテ顧客の手動登録。冪等 (requestHash に登録店舗を含む) + audit。2026-08-26 に staff 開放 |
| `PUT /api/admin/customers/:id/memo` | ✅ 承認要・自店舗顧客のみ | ✅ | ✅ | `prepareCustomerMutation` → `writeCustomerText`。actor・店舗・非archive/非mergeを同一batchで確認。optional `expectedMemo` が不一致なら409、成功時だけ監査を書く。未指定の旧UIは従来の更新を維持 |
| `PUT /api/admin/customers/:id/referrer` | ✅ 承認要・自店舗顧客のみ | ✅ | ✅ | `prepareCustomerMutation`。紹介者名は任意、期待値必須。actor検査・店舗・非archive/非merge・CASを同一batchで照合し、成功時だけ本文を含めない監査を書く |
| `PATCH /api/admin/customers/:id/profile` | ✅ 承認要・自店舗顧客のみ | ✅ | ✅ | `assertStaffCustomerStoreScope` (shared.ts) |
| `GET /api/admin/customers/:id/visits` (来店履歴の続き) | ✅ 承認要・自店舗顧客のみ・自店舗の来店のみ | ✅ 全顧客 | ✅ | `listAdminCustomerVisits(admin)` が詳細と同じ store-scope gate を通し、同じ 1 ページ分のクエリ (`selectCustomerVisitsPage`) を offset 付きで引く (operations.ts) |
| `GET /api/admin/customers/:id/reservations` (予約履歴の続き) | ✅ 承認要・自店舗顧客のみ・自店舗の予約のみ | ✅ 全顧客 | ✅ | `listAdminCustomerReservations(admin)`。店舗制限をLIMIT/OFFSET前に適用し、50件ずつ日時・IDの降順で返す。archiveは閲覧可 |
| `GET /api/admin/customers/:id/consents` (通常同意履歴の続き) | ✅ 承認要・自店舗顧客の自店舗予約に紐付く記録のみ | ✅ 全顧客 | ✅ | `authenticateAdminRoute` → `assertCustomerTabGate` → `listAdminCustomerConsents`。staffは顧客所属と予約の現在customer/store一致を照合する。同意の保存元が既存統合で同一顧客と証明できる旧顧客も含めるが、無関係な所有者不一致や予約との紐付け不明な記録は返さない。50件単位でopaque記録ID・同意種別・版・日時だけを返す |
| `PUT /api/admin/customers/:id/visits/:visitId/notes` | ✅ 承認要・自店舗 visit のみ (書き込みなので予約詳細パネルからの編集も承認が要る) | ✅ | ✅ | routeでvisit店舗を確認し、actor・店舗・有効visit・顧客非archive/非mergeを同一batchで再確認。optional `expectedTreatmentNotes` が不一致なら409、成功時だけ監査を書く。未指定の旧UIは従来の更新を維持 |
| `POST /api/admin/customers/:id/visits` (手動来店追加) | ❌ | ✅ | ✅ | `authenticateOwnerWithJsonBody` で owner+ |
| `PATCH /api/admin/customers/:id/visits/:visitId` (手動来店の日付編集) | ❌ | ✅ | ✅ | `authenticateOwnerWithJsonBody` → `updateAdminCustomerVisit`。予約由来 visit は immutable (`reservation_linked`) |
| `DELETE /api/admin/customers/:id/visits/:visitId` (手動来店削除) | ❌ | ✅ | ✅ | `authenticateAdminRoute` + `requireOwnerWithDb` → `deleteAdminCustomerVisit`。DELETE は JSON body 無しのため owner JSON gate ではなく `requireOwnerWithDb` |
| `GET /api/admin/customers/merge-candidates` | ❌ | ✅ | ✅ | `requireOwnerWithDb` |
| `POST /api/admin/customers/:id/merge` | ❌ | ✅ | ✅ | `requireAdminContext` + merge ドメイン層 (店舗横断・破壊的のため owner 限定) |
| `POST /api/admin/customers/:id/archive` | ✅ 承認要・自店舗スコープの顧客のみ | ✅ | ✅ | `setAdminCustomerArchiveStatus` の `staffMayActOnCustomer` (customer-actions.ts)。入力検証の直後・冪等読取より前に判定 |
| `POST /api/admin/customers/:id/unarchive` | ✅ 承認要・自店舗スコープの顧客のみ (アーカイブ済みを判定対象に含む) | ✅ | ✅ | 同上。archive/unarchive の両方向で `includeArchived: true`（アーカイブ済みかどうかは authz ではなく状態。これが無いと復元も、同一冪等キーでの archive 再送も 403 になる） |
| `POST /api/admin/customers/:id/block` | ✅ 承認要・自店舗スコープの顧客のみ | ✅ | ✅ | `setAdminCustomerBlockStatus` の `staffMayActOnCustomer` (customer-actions.ts)。ブロックは全店舗に効く共通状態 |
| `POST /api/admin/customers/:id/unblock` | ✅ 承認要・自店舗スコープの顧客のみ | ✅ | ✅ | 同上。アーカイブ済み顧客は対象外 (`fetchCustomer` が `archived_at IS NULL` を要求) なので、先に復元が要る |
| `POST /api/admin/customers/:id/delete` (完全削除・不可逆) | ❌ | ✅ | ✅ | `executeAdminCustomerDelete` で staff forbidden (customer-delete.ts)。顧客と全関連行を FK 順で物理削除。**確定/未来の予約・稼働中 Google イベント・処理中 Google 同期がある場合は 409 拒否**(先にアーカイブ/取消)。通常運用はアーカイブ推奨で、これはテストデータ整理用 |

### 外部ブロック (external blocks)

| Endpoint | staff | owner | system_admin | 既存ガード位置 | Phase 0b 作業 |
|---|---|---|---|---|---|
| `GET /api/admin/external-blocks` | ✅ readonly | ✅ | ✅ | role 制約なし (一覧 read は全 role) | 変更なし |
| `POST /api/admin/external-blocks` (作成) | ❌ | ✅ | ✅ | `createAdminExternalBlock` で staff forbidden (external-blocks.ts:277) | 変更なし |
| `POST /api/admin/external-blocks/:id/cancel` | ❌ | ✅ | ✅ | `cancelAdminExternalBlock` で staff forbidden (external-blocks.ts:501) | 変更なし |

### 設定 (settings)

設定の write 系エンドポイントは実装済み（Phase 4 設定管理 shipped）。ガードは2系統ある:

- `isAdminPrivileged(role)` = owner / system_admin のみ（staff 不可）。
- `isAdminAllowedForStoreSettings(admin, storeId)` = owner / system_admin は常に可、staff は **自分の所属店舗 (`admin.store_id === storeId`) に限り可**。

「staff 自店舗可」を採用しているのは **services / closures / business-hours** の3系統。resources は owner+ のまま（`store_resources` の削除は slot_locks / slot_lock_history / external_blocks へ CASCADE し予約枠状態を静かに落とすため。`reservations.resource_id` 自体は ON DELETE RESTRICT — `settings-common.ts` のコメント参照）。スタッフ CRUD は権限昇格リスクのため owner+ 固定。

| Endpoint | staff | owner | system_admin | 既存ガード位置 |
|---|---|---|---|---|
| `GET /api/admin/settings` | ✅ readonly (自店舗 scope の stores/resources/services/businessHours/closures の allowlist。staff/reminder 等の設定は返さない。店舗 binding なしの staff は 403) | ✅ | ✅ | `admin-api.ts` GET /settings: staff は allowlist + `staffHasStore` ガード + 自店舗 filter。owner+ は全 snapshot |
| `POST /api/admin/settings/services` | ✅ 自店舗のみ | ✅ | ✅ | `isAdminAllowedForStoreSettings` (settings-services.ts)。staff は request の store_id が自店舗のとき可 |
| `PUT /api/admin/settings/services/:id` | ✅ 自店舗のみ | ✅ | ✅ | `isAdminAllowedForStoreSettings` (settings-services.ts)。対象サービスの store_id で判定 |
| `DELETE /api/admin/settings/services/:id` | ✅ 自店舗のみ | ✅ | ✅ | 同上 |
| `POST /api/admin/settings/resources` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-resources.ts) |
| `PUT /api/admin/settings/resources/:id` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-resources.ts) |
| `DELETE /api/admin/settings/resources/:id` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-resources.ts) |
| `POST /api/admin/settings/staff` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-staff.ts)。自身の active 1→0 / 降格は `forbidden_self_deactivation` で別途拒否 |
| `PUT /api/admin/settings/staff/:id` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-staff.ts) |
| `DELETE /api/admin/settings/staff/:id` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-staff.ts) |
| `POST /api/admin/settings/closures` | ✅ 自店舗のみ | ✅ | ✅ | `isAdminAllowedForStoreSettings` (settings-closures.ts: create は request.storeId で判定) |
| `PUT /api/admin/settings/closures/:id` | ✅ 自店舗のみ | ✅ | ✅ | `isAdminAllowedForStoreSettings` (settings-closures.ts: update は DB 上の current.store_id。cross-store 移動は `guardImmutableStore` が 409) |
| `DELETE /api/admin/settings/closures/:id` | ✅ 自店舗のみ | ✅ | ✅ | 同上 (delete も current.store_id) |
| `PUT /api/admin/settings/reminder` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-reminder.ts:92) |
| `PUT /api/admin/settings/reservation-cap` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-reservation-cap.ts:84)。1顧客あたり予約上限 (#290) |
| `PUT /api/admin/settings/booking-window` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-booking-window.ts:91)。予約受付期間1..90日 (#309) |
| `PUT /api/admin/settings/customer-notice` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-customer-notice.ts)。予約ページのお客様向けお知らせ 500字上限 |
| `PUT /api/admin/settings/google-edit-mode` | ❌ | ✅ | ✅ | `isAdminPrivileged` (settings-google-edit.ts) |
| `GET /api/admin/settings/business-hours/:storeId` | ✅ 自店舗のみ | ✅ | ✅ | route 層で自店舗ガード (admin-api.ts) |
| `PUT /api/admin/settings/business-hours/:storeId` | ✅ 自店舗のみ | ✅ | ✅ | `isAdminAllowedForStoreSettings` (settings-business-hours.ts:79) |

### 店舗ログイン (store logins) — #308

オーナーが各店舗の共有ログイン用メールを事前登録し、スタッフ初回ログインで JWT subject を自動バインドするセルフサービス機構。route 側で `isAdminPrivileged` を即時チェック（GET）し、mutation はドメイン層 (`src/admin/settings-store-login.ts`) が `forbidden` / `forbidden_self_deactivation` を返す。

| Endpoint | staff | owner | system_admin | 既存ガード位置 |
|---|---|---|---|---|
| `GET /api/admin/store-logins` | ❌ 403 | ✅ | ✅ | route で `isAdminPrivileged(role)` 即時 403 (admin-api.ts:1612) |
| `POST /api/admin/store-logins` (登録/更新) | ❌ | ✅ | ✅ | `upsertStoreLogin` → `isAdminPrivileged` (settings-store-login.ts:558)。email 横取り防止 (`email_in_use`→409)・自己無効化防止 (`forbidden_self_deactivation`→403)。2026-08-30 追加: Case B で role が実際に変わるときは顧客タブの承認 (spec 008) を同じ batch で落とす — `admin_users.role` を書き換えるもう 1 本の経路なので、スタッフ設定側と揃えないと staff → owner → staff の往復で承認が生き残る |
| `DELETE /api/admin/store-logins/:storeId` (失効) | ❌ | ✅ | ✅ | `revokeStoreLogin` → `isAdminPrivileged` (settings-store-login.ts:680) + 自己失効防止 |

### LINE友だち紐付け (line friends) — #291-292

公式LINEの友だちを紙カルテ顧客へ手動紐付けする機構。全 mutation がドメイン層 (`src/admin/line-friends.ts`) で `isAdminPrivileged`（owner+）。

| Endpoint | staff | owner | system_admin | 既存ガード位置 |
|---|---|---|---|---|
| `POST /api/admin/line-friends/sync` (友だち名簿同期) | ❌ | ✅ | ✅ | `isAdminPrivileged` (line-friends.ts) |
| `GET /api/admin/line-friends` (一覧) | ❌ | ✅ | ✅ | `isAdminPrivileged` (line-friends.ts) |
| `POST /api/admin/line-friends/:lineUserId/link` (顧客へ紐付け) | ❌ | ✅ | ✅ | `isAdminPrivileged` (line-friends.ts) |

> 脚注: 以前記載していた line-friends の ignore / unignore 操作（当時は POST …/line-friends/:lineUserId/ignore と unignore）は src にルート実装が無く、2026-08-09 のルート突合で幽霊記載として削除した。`git log -S` でも一度も存在した形跡が無い。このマトリクスは実装済みルートを対象とする。

### LINE 配信枠 (line quota)

| Endpoint | staff | owner | system_admin | 既存ガード位置 |
|---|---|---|---|---|
| `GET /api/admin/line-quota` | ❌ | ✅ | ✅ | `authenticateAdminRoute` + `requireOwnerWithDb` (admin-api.ts)。当月 LINE push 利用数のスナップショット読取のみ (LINE API は叩かない) |

### 管理画面 Web Push (notifications)

全 role が自分の端末を購読できる。ペイロードは送信時に `loadStoreSubscriptions` で店舗 scope される。CSRF / Sec-Fetch-Site は route 共通 middleware、mutation rate limit は `authenticateAdminWithDb` 側。

| Endpoint | staff | owner | system_admin | 既存ガード位置 |
|---|---|---|---|---|
| `POST /api/admin/notifications/push/subscriptions` | ✅ 自分の購読のみ | ✅ | ✅ | `authenticateAdminWithDb` → `savePushSubscription(admin.id, ...)` (admin-push.ts)。endpoint は push サービス allow-list で検証 |
| `POST /api/admin/notifications/push/unsubscribe` | ✅ 自分の購読のみ | ✅ | ✅ | `authenticateAdminWithDb` → `deletePushSubscription(admin.id, endpoint)`。endpoint 単独削除は不可 (他 admin 端末を黙らせない) |
| `POST /api/admin/notifications/push/test` | ✅ 自分の端末へテスト送信 | ✅ | ✅ | `authenticateAdminWithDb` → `sendAdminPushTest(..., admin.id)` |

### 監査ログ (audit logs)

| Endpoint | staff | owner | system_admin | 既存ガード位置 | Phase 0b 作業 |
|---|---|---|---|---|---|
| `GET /api/admin/audit-logs` | ❌ | ✅ | ✅ (metadata 全表示) | `listAdminAuditLogs` で staff forbidden (operations.ts:767)、metadata は system_admin のみ | 変更なし |

### 同期 (sync recovery)

| Endpoint | staff | owner | system_admin | 既存ガード位置 | Phase 0b 作業 |
|---|---|---|---|---|---|
| `GET /api/admin/sync/status` | ✅ readonly (自店舗の簡易警告) | ✅ 集計と許可済み2種の判断対象。staff紐付け時は有効な所属店舗、紐付けなしは全店舗 | ✅ 詳細 | `getAdminSyncStatus` でrole別のsafe projection (sync-status.ts)。ownerへprovider ID/raw snapshotは返さない | ✅ 2026-09-29 更新 |
| `POST /api/admin/sync/jobs/retry` | ❌ | ❌ | ✅ | `retryAdminSyncJob` で `role !== 'system_admin'` を 403 (sync-recovery.ts) | 変更なし |
| `POST /api/admin/sync/jobs/acknowledge` | ❌ | ❌ | ✅ | `acknowledgeAdminSyncJob` で `role !== 'system_admin'` を 403。Google import dead / 通知 dead・failed の確認済み処理。通知は履歴保持・再送禁止 (sync-recovery.ts) | ✅ 2026-09-12 更新 |
| `POST /api/admin/sync/conflicts/:id/ignore` | ❌ | ❌ | ✅ | `resolveAdminGoogleConflict` → system_admin gate (sync-recovery.ts) | 変更なし |
| `POST /api/admin/sync/conflicts/:id/manual-resolve` | ❌ | ❌ | ✅ | 同上 | 変更なし |
| `POST /api/admin/sync/all-day-candidates/:conflictId/approve` | ❌ | ✅ | ✅ | `guardConflictAction` (shared.ts) + `approveAllDayAsClosure` の `isAdminPrivileged` (conflict-resolutions.ts) | ✅ 2026-08-09 追記 |
| `POST /api/admin/sync/all-day-candidates/:conflictId/reject` | ❌ | ✅ | ✅ | `guardConflictAction` + `rejectAllDayConflict` の `isAdminPrivileged` (conflict-resolutions.ts) | ✅ 2026-08-09 追記 |
| `POST /api/admin/sync/conflicts/:conflictId/approve-cancel` | ❌ | ✅ | ✅ | `guardConflictAction` + `approveReservationDeleteAsCancel` の `isAdminPrivileged` (conflict-resolutions.ts) | ✅ 2026-08-09 追記 |
| `POST /api/admin/sync/conflicts/:conflictId/reject-delete` | ❌ | ✅ | ✅ | `guardConflictAction` + `rejectReservationDeleteConflict` の `isAdminPrivileged` (conflict-resolutions.ts) | ✅ 2026-08-09 追記 |

### 定期ブロック (recurring external blocks)

| Endpoint | staff | owner | system_admin | 既存ガード位置 |
|---|---|---|---|---|
| `POST /api/admin/recurring/preview` | ❌ | ✅ | ✅ | route で `role === "staff"` を 403 (admin-api.ts)。RRULE 展開のみで DB 書込なし |
| `POST /api/admin/recurring/commit` | ❌ | ✅ | ✅ | `requireAdminContext` + `commitAdminRecurring` の `isAdminPrivileged` (recurring-commit.ts)。成功時は Google queue を kick |

### Staging 専用

本番 (`ENVIRONMENT !== "staging"`) では 404。staging でも `system_admin` のみ。

| Endpoint | staff | owner | system_admin | 既存ガード位置 |
|---|---|---|---|---|
| `POST /api/admin/staging/drift-sweep` | ❌ | ❌ | ✅ (staging のみ) | `requireStagingSystemAdmin` (staging-drift-sweep.ts)。非 staging は 404。サービス帳票トークン可 |
| `POST /api/admin/staging/sentry-test` | ❌ | ❌ | ✅ (staging のみ) | `requireStagingSystemAdmin` (staging-sentry-test.ts)。合成例外を Sentry へ送る検証用 |

### HTML routes

| Route | staff | owner | system_admin | 動作 |
|---|---|---|---|---|
| `GET /admin` | redirect 302 → `/admin/staff` | tab shell | tab shell | Phase 0b で実装 |
| `GET /admin/staff` | 簡易 timetable view | アクセス可 (staff モードを直接見たい時用) | アクセス可 | Phase 0b で新規追加、CSP header 付与必須 |
| `GET /admin/sync` | 301 → `/admin#sync` | 301 → `/admin#sync` | 301 → `/admin#sync` | Phase 0b で /admin に統合 |

## Phase 0b 追加 server-side guard (集中作業)

> ✅ **実装済み (PR#384)** — `validateAdminActionAuthorization` (src/admin/reservations.ts) が staff の store scope を全 action に、`canCancel` の当日 JST 制約を approve 以外の全 action に適用している。以下は当時の作業メモとして残す。
> **2026-07-04 更新 (全予約承認制)**: reject も approve と同列に当日ガード対象外へ変更した。現在 `canCancel` の当日制約が適用されるのは cancel / complete / no-show / reschedule。(check-in アクションは 2026-07-21 に撤去。checked_in_at カラム/派生ステータスは休眠温存。)

唯一の追加対象は **`runAdminReservationAction`** (src/admin/reservations.ts) の reject / complete / no-show / reschedule action。reservation.start_at が当日 JST 外 (staff role) なら 403 `forbidden` を返す。`cancel` action は既に `canCancel(role, startAt, nowMs)` で同等のチェックが入っているので、それと同じ判定関数を 4 action 共通で適用する。

sync-recovery 系 (`retrySyncJob`, `resolveAdminGoogleConflict`) は **すでに system_admin only** で適切にガード済み。Phase 0b で変更は無い。

## テスト戦略

`docs/admin-authz-matrix.md` の各行 × 各 role の組み合わせで integration test を作成 (vitest + miniflare D1)。具体的には:
- staff が他日 reservation を action リクエスト → 403 `forbidden` を期待
- staff が `/api/admin/sync/jobs/retry` リクエスト → 403
- owner / system_admin が同 endpoint → 200 / 適切な response

既存 `test/admin-create-reservation.test.ts` 等のパターンを流用、各 endpoint で role × scope の最低 2 ケースを追加。

## 注記

- `system_admin` は `owner` の superset (現状)、将来 audit metadata 以外で振る舞い差分を増やす場合は本マトリクスを更新
- frontend (admin.js + 新 module) で `data-admin-role` meta tag を読んで button を hide する既存実装は維持するが、これは UX 用であり認可の primary 防御は server-side。frontend hide のみに依存する箇所があれば Phase 0b で server guard を追加
- ルート有無の正本は `createApp().routes`。`test/admin-authz-matrix-sync.test.ts` が本表のバッククォート endpoint と実登録ルートの対称差分を検証する。新 `/api/admin/*` を足したら同 PR で本表も更新すること

## Phase 0b 完了条件

- 全 endpoint で「staff 不可」を要件とする path に data layer ガード存在
- 全 endpoint × 全 role の網羅テスト追加 (推定: 行数 23 × role 3 = 69 ケース、既存重複除く)
- 本マトリクスドキュメントが user 承認済み

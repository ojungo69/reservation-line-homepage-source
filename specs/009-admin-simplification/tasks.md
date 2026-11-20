# Tasks: 管理画面の整理（使わない欄と表示を減らす）

**Input**: Design documents from `/specs/009-admin-simplification/`

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、contracts/ui-fields.md、quickstart.md

**Tests**: 試験を先に書く（plan.md の「検証」）。新しい動作の試験は、実装の前に正しい理由で赤くなるのを見る。今の動作を固定する試験（FR-025 など）は、今のコードで緑のまま通るのを見る。期待値は固定の値で書き、試験の中でコードと同じ計算をし直さない。

**Organization**: ユーザーストーリーごとの段に分ける。プルリクエストは 2 つで、触るファイルは `admin-app/src/pages/schedule.test.tsx` の試験だけが重なる（別の箇所なので、合わせてもぶつからない）。どちらを先にマージしてもよい。

- **PR A**: 段 2（土台）、US1、US2 のうち FR-008〜010・012、US3、US5 のうち FR-015、spec の文書
- **PR B**: US2 のうち FR-011、US4、US5 のうち FR-021〜023

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 別のファイルを触り、終わっていない作業に依存しないので、同時に進められる
- **[Story]**: 対応するユーザーストーリー（US1〜US5）

## Path Conventions

- 管理画面: `admin-app/src/`。試験は同じフォルダの `*.test.ts(x)`。
- Worker: `src/`。試験は `test/`。
- 配備と検査の設定ファイルは触らない（plan.md の Constraints）。

---

## Phase 1: Setup

- [X] T001 依存を入れた作業ツリーで、`package.json` の `npm run test:unit` と `admin-app/package.json` の `npm run admin:test` を今のコードのまま一度通し、もともと落ちる試験が無いことを記録する（以後の赤が、この整理で書いた試験か、この整理が壊したものだけになるように）

---

## Phase 2: Foundational（PR A）

**Purpose**: 作成パネル・ブロック作成・繰り返しブロック・予約の詳細が使う、リソースの判断の純関数（[data-model.md](./data-model.md)）。

**⚠️ CRITICAL**: US1・US2（FR-008）・US3 は、この段が終わってから始める。PR B の作業は、この段を待たなくてよい。

- [X] T002 `admin-app/src/lib/store-resources.test.ts` を新しく書き、赤を確かめる。
  - `resolveStoreResources(resources, storeId, selectedId, keepChoice = false)`:
    - `resources` が `undefined` → `{ kind: "unknown", resourceId: "" }`
    - `storeId` が `""`・`null`・`undefined` → `unknown`（ほかの店舗の枠があっても選ばない）
    - 稼働中の枠が 0（停止中だけ、またはほかの店舗の枠だけ）→ `{ kind: "none", resourceId: "" }`
    - 稼働中がちょうど 1 → `single`。`resourceId` はその枠の id。`selectedId` が停止中の枠・ほかの店舗の枠でも、その店舗の稼働中の枠になる
    - 稼働中が 2 つ以上 → `multiple`。`resources` は稼働中の枠だけ。`selectedId` が候補にあればその値、空・停止中・ほかの店舗・存在しない id なら `""`
    - `keepChoice` が真（利用者が選んだ枠）で、`selectedId` が同じ店舗の枠なのに稼働中の唯一の枠と違う（選んでいた枠が止まった）→ `single` にせず `multiple`（残った枠だけ、`resourceId` は `""`）。レビューで足した（前の予約から引き継いだ初期値は `keepChoice` にしない）
  - `resolveCreateTarget(settings, chosenStoreId, chosenResourceId, keepChoice = false)`:
    - 設定の店舗が 1 件 → `soleStore: true`。`chosenStoreId` が空でも `storeId` はその店舗の id、`storeName` はその店舗名
    - 店舗が 2 件 → `soleStore: false`。`storeId` は選んだ値のまま
    - `settings` が `null` → `saveBlocked: true`、`resources.kind` は `unknown`
    - 選んだ店舗の稼働中の枠が 0 → `saveBlocked: true`
    - 店舗を s1 から s2 に変えると、s1 の枠の id を渡したままでも、`resources.resourceId` は s2 の枠になる（s2 の枠が 2 つ以上なら空）
    - 店舗が未決定（2 件で選んでいない）→ `saveBlocked: false`（今どおり、保存のときの必須の検査で止める）
- [X] T003 `admin-app/src/lib/store-resources.ts` を実装して T002 を緑にする。
  - 型 `StoreResources`（`unknown`・`none`・`single`・`multiple`。どれも `resourceId` を持つ）、`resolveStoreResources`、`resolveCreateTarget` を置く。
  - 案内の文の定数を 2 つ置く。手動予約: 「この店舗は予約枠が未設定のため、予約を作成できません。」。ブロックと繰り返しブロック: 「この店舗は予約枠が未設定です。店舗設定の「リソース」タブで追加してください。」
  - ファイルの先頭に、`resources` を渡すのは取得が成功したときだけ、という決まりを 1〜2 行で書く。

**Checkpoint**: 土台の試験が緑。ここで 1 回 commit する。

---

## Phase 3: User Story 1 - 手動予約を少ない入力で入れる (Priority: P1) 🎯 MVP（PR A）

**Goal**: 枠が 1 つの店舗で、リソース・店舗・予約経路に触れずに手動予約を保存できる。

**Independent Test**: 枠が 1 つの店舗で、店舗スタッフとして作成画面を開き、メニュー・日時・お客様だけで保存する。その枠に、経路 `walk_in`（「店頭」）で保存される。

FR-026 の作成側は、今の予定表と新しい予定表が同じ作成パネルを使うので、パネルの試験で満たす。新しい予定表の初期値の渡し方は、既存の `admin-app/src/pages/schedule-v2.test.tsx` が確かめている（変えない）。

### Tests for User Story 1（先に書き、赤を確かめる）

- [X] T004 [P] [US1] `admin-app/src/lib/reservation-origin.test.ts` に、`DEFAULT_CREATE_ORIGIN` が `"walk_in"` で、`RESERVATION_ORIGIN_OPTIONS` の値の 1 つであることを足す。選択肢の並び（minimo・walk_in・other）と表示名の既存の試験は変えない
- [X] T005 [US1] `admin-app/src/components/schedule/reservation-create-panel.test.tsx` の `useSettings` のモックを、試験ごとに設定を差し替えられる形にする。用意する設定は 5 つ: 1 店舗・枠 1、2 店舗・各枠 1、1 店舗・枠 2、1 店舗・稼働中の枠 0、未取得。その上で次を書く:
  - FR-001: 枠 1 では「リソース」の欄が無く、送る `resourceId` がその枠
  - FR-002: 枠 0 では「この店舗は予約枠が未設定のため、予約を作成できません。」が出る。「予約作成」が押せず、作成が呼ばれない
  - FR-003: 枠 2 では欄が出る。選ばずに送ると「必須項目を入力してください」、選ぶとその枠で送る
  - FR-004: 次の 3 つを確かめる
    - 2 店舗で店舗を切り替えると、送る `storeId` と `resourceId` が新しい店舗のものになる
    - 未取得の間は「予約作成」が押せず、取得のあとで押せる
    - 前の予約から作るときに停止中の枠が初期値で渡されても、枠 1 の店舗では、その店舗の稼働中の枠で送る
  - FR-005: 1 店舗では「店舗」の欄が無く、メニューがすぐ選べ、確認の画面に店舗名が出る。2 店舗では欄が出る
  - FR-006: 開いた直後の予約経路が「店頭」で、そのまま送ると `origin: "walk_in"` になる。何も入れずに閉じても、破棄の確認が出ない
  - FR-007: 枠 1 では、確認の画面に「担当：」が無く、空き枠の一覧にリソース名の見出しが無い（枠のボタンは出る）。枠 2 では両方出る
  - 既存の試験を次のように直す
    - 必須の欄を確かめる `it.each` のうち、枠 1 の設定で消える「店舗」「リソース」の場合は、欄が出る設定の場合に移す
    - 店舗が未選択のときの案内の試験は、2 店舗の設定にする
    - 送る内容の期待値に `origin: "walk_in"` を足す
- [X] T006 [P] [US1] `admin-app/src/pages/schedule.test.tsx` の、全店舗の表示で別の店舗の空き枠から作成を開く試験を直す。今は「リソース」の欄の中身を見ているので、リソースの欄が無く、その店舗の枠で送ることを見る形にする

### Implementation for User Story 1

- [X] T007 [US1] `admin-app/src/lib/reservation-origin.ts` に `export const DEFAULT_CREATE_ORIGIN: CreateReservationOrigin = "walk_in"` を足す（T004 を緑に）
- [X] T008 [US1] `admin-app/src/components/schedule/reservation-create-panel.tsx` を、`resolveCreateTarget` で導いた有効な店舗と枠を使う形にする（T005・T006 を緑に）
  - 導いた値は state に書き戻さない。検査・送信・空き枠の取得・メニューの絞り込み・確認の画面には、有効な値を使う
  - 「店舗」の欄は `soleStore` のときに出さない。店舗を切り替えたときに枠・メニュー・お客様を空にする処理は残す
  - 「リソース」の欄は `multiple` のときだけ出す。`none` のときは、欄の代わりに案内（`role="status"`）を出す。`saveBlocked` のときは「予約作成」を押せなくする
  - 空き枠の見出しは、送れる枠が 2 つ以上のときだけ出す（選び直しで `multiple` の候補が 1 つのときは出さない）。確認の画面の「担当」は、送る枠がその店舗の唯一の稼働中の枠と同じときだけ出さない（レビューで、確認の間に設定が変わる場合に合わせて改めた）
  - 予約経路の初期値・リセット・変更の有無の判定の 3 か所で `DEFAULT_CREATE_ORIGIN` を使う。変更の有無の判定では、店舗と枠を生の state のまま比べる（導いた値と比べると、開いた直後から「変更あり」になる）
  - 分岐は `&&` か小さな関数に出し、部品の認知的複雑度を増やさない

**Checkpoint**: US1 の試験が緑。作成パネルを開く今の予定表と新しい予定表の試験も緑。

---

## Phase 4: User Story 2 - 予約の詳細とカードを読みやすくする (Priority: P1)

**Goal**: 枠が 1 つの店舗の予約で、詳細・変更の画面・カード・カルテの履歴にリソース名が出ない。開始時刻と長さの変更の名前で、違いが分かる。

**Independent Test**: 枠が 1 つの店舗の予約を開き、次を見る。

- リソース名・「担当」・「来店履歴」の欄が無い。
- ボタンが「開始時刻を変更」「長さを変更」になっている。
- 変更の画面の文に、リソース名が無い。

FR-026 の詳細側は、今の予定表・新しい予定表・予約管理・顧客カルテが同じ詳細パネルを使うので、パネルの試験で満たす。

### Tests for User Story 2（PR A。先に書く）

- [X] T009 [US2] `admin-app/src/components/schedule/reservation-detail-panel.test.tsx` に、店舗スタッフでも顧客メモとアレルギー・注意事項の値が出ることを固定する試験を足す。今のコードで緑のまま通ることを確かめる（FR-025。詳細パネルを変える前に入れる）
- [X] T010 [US2] 同じファイルで `@/hooks/use-settings` をモックし（試験ごとに設定を差し替えられる形）、次を書いて赤を確かめる
  - FR-008: リソースの行の出し分け
    - 出ない: 店舗の稼働中の枠が 1 つで、予約がその枠のとき。設定の読み込み中のとき
    - 出る: 稼働中の枠が 2 つのとき。予約の枠が停止中のとき。設定の最初の取得に失敗したとき
  - FR-010: 確定・承認待ちの予約では、「開始時刻を変更」「長さを変更」のボタンがあり、「時間変更」「施術時間変更」は無い。完了の予約では、どちらのボタンも無い
  - FR-012: 来店履歴の欄と、確認の文
    - 「来店履歴」の見出しが無い。「施術メモ」と、その編集のボタンは残る
    - 「来店なしに訂正」の確認の文に「来店履歴」が無く、「この予約の来店の記録が無効になり」がある
    - 「完了に戻す」の確認の文にも「来店履歴」が無い
- [X] T011 [P] [US2] `admin-app/src/components/schedule/reservation-reschedule-dialog.test.tsx`（無ければ作る）に、次を書く: 題名が「開始時刻を変更」、送信のボタンが「この開始時刻に変更」、画面の文に試験の枠の名前が無い
- [X] T012 [P] [US2] `admin-app/src/components/schedule/reservation-duration-dialog.test.tsx` に、次を書く
  - 題名が「長さを変更」、送信のボタンが「この長さに変更」。今の「施術時間を変更」のボタンを押している 3 か所も直す
  - 画面の文に「担当」が無く、「開始時刻（09:00）はそのままに」がある
  - 固定のデータの `resourceName` は消す
- [X] T013 [P] [US2] `admin-app/src/hooks/use-reservations.test.tsx` の完了の通知の期待値を、「開始時刻を変更しました」「長さを変更しました」にする

### Implementation for User Story 2（PR A）

- [X] T014 [US2] `admin-app/src/components/schedule/reservation-detail-panel.tsx` を直す（T010 を緑に）
  - `useSettings` を読む。次の 2 つのときは「リソース」の行を出さない: `resolveStoreResources` が `single` で予約の `resourceId` がその枠のとき、設定の読み込み中のとき
  - ボタンの名前を「開始時刻を変更」「長さを変更」にする
  - 変更の画面へ渡す値から `resourceName` を外す
  - 「来店履歴」の欄と、使われなくなる読み込みを消す
  - 来店なしへの訂正と、完了に戻すの確認の文から「来店履歴」を外す
  - 顧客メモとアレルギー・注意事項の部分は触らない
- [X] T015 [P] [US2] `admin-app/src/components/schedule/reservation-reschedule-dialog.tsx` を直す（T011 を緑に）
  - 受け取る型から `resourceName` を消す。空き枠の絞り込みに使う `resourceId` は残す
  - 題名を「開始時刻を変更」にする
  - 説明の文を「施術時間はそのままに、開始時刻を移動します。確定済みの予約はお客様に変更が通知されます。」にする
  - 空き枠の見出しを「空き枠」、送信のボタンを「この開始時刻に変更」にする
- [X] T016 [P] [US2] `admin-app/src/components/schedule/reservation-duration-dialog.tsx` を直す（T012 を緑に）
  - 受け取る型から `resourceName` を消す
  - 題名を「長さを変更」にする
  - 説明の文を「開始時刻（{時刻}）はそのままに、施術時間の長さだけを変更します。」にする
  - 送信のボタンを「この長さに変更」にする
  - 入力の欄のラベルと「現在の施術時間」の文は変えない
- [X] T017 [P] [US2] `admin-app/src/hooks/use-reservations.ts` の完了の通知の文を「長さを変更しました」「開始時刻を変更しました」にする（T013 を緑に）。API のパスとエラーの文は変えない

### FR-011 の試験と実装（PR B）

- [ ] T018 [P] [US2] `admin-app/src/components/schedule/reservation-list-card.test.tsx` に、`resourceName` を持つ予約でも、店舗名だけが出て、リソース名と「 · 」が出ないことを書き、赤を確かめる。今の「店舗名 · リソース名」を期待する試験も直す
- [ ] T019 [P] [US2] `admin-app/src/components/customers/customer-detail-panel.test.tsx` に、予約履歴のカードにリソース名が出ず、店舗名が出ることを書く（カードの中に絞って探す）
- [ ] T020 [US2] `admin-app/src/components/schedule/reservation-list-card.tsx` の受け取る型から `resourceName` を消し、店舗名だけを出す（T018 を緑に）
- [ ] T021 [US2] `admin-app/src/components/customers/customer-detail-panel.tsx` の予約履歴のカードを、店舗名だけにする（T019 を緑に）。API の型の `resourceName` は残す

**Checkpoint**: US2 の試験が緑。

---

## Phase 5: User Story 3 - ブロック・繰り返しブロック・休業日を少ない入力で登録する (Priority: P2)（PR A）

**Goal**: 枠が 1 つの店舗で、リソースに触れずにブロックと繰り返しブロックを登録できる。1 日だけの休業を、日付を 1 回選ぶだけで登録できる。

**Independent Test**: 枠が 1 つの店舗で、ブロックと繰り返しブロックを登録する。休業日の追加で開始日だけを選んで保存する。

### Tests for User Story 3（先に書き、赤を確かめる）

- [X] T022 [P] [US3] `admin-app/src/hooks/use-settings-hooks.test.tsx` に、`useResourceList` が返す `isLoaded` を書く。データがあれば `true`（取り直しに失敗しても前のデータが残れば `true`）、読み込み中と最初の取得の失敗は `false`
- [X] T023 [P] [US3] `admin-app/src/components/schedule/external-block-create-dialog.test.tsx`（新規）に、次を書く
  - 枠 1: 「リソース」の欄が無い。開始・終了を入れて作成すると、その枠で送る。説明の文が「選んだ時間帯を予約不可にします。時刻は5分単位で指定してください。」で、「リソース」の語が無い
  - 枠 0: 「この店舗は予約枠が未設定です。店舗設定の「リソース」タブで追加してください。」が出て、作成できない
  - 枠 2: 欄が出て、選ぶまで作成できない
  - 設定の最初の取得に失敗: 0 件の案内を出さず、作成できない
- [X] T024 [P] [US3] `admin-app/src/components/settings/recurring-blocks-tab.test.ts` の `derivePreviewInvalid` の試験に、7 つ目の引数（リソースの判断の `kind`）を足す。既存の場合は `multiple` を渡す。`none` のときは、ほかが全部有効でも、曜日が未選択でも、枠が未設定の理由が返ることを書く
- [X] T025 [P] [US3] `admin-app/src/components/settings/recurring-blocks-tab.form.test.tsx`（新規）に、次を書く
  - 枠 1: 欄が無く、プレビューから作成まで進むと、その枠で送る
  - 枠 0: 案内が出る
  - 枠 2: 欄が出る
  - 読み込みが終わったあとに、冪等性のキーが新しく作られる（今の動作を固定する）
- [X] T026 [P] [US3] `admin-app/src/components/settings/closures-tab.test.tsx`（無ければ作る）に、次を書く
  - 追加の画面で開始日を選ぶと、終了日に同じ日付が入る
  - 終了日を自分で変えたあとは、開始日を変えても追従しない
  - 編集の画面では追従しない
- [X] T027 [P] [US3] `admin-app/src/components/settings/settings-regressions.test.tsx` を直す。設定の読み込みの前に「リソース」の欄を探している試験を、枠の数で出し分ける新しい動作に合わせる

### Implementation for User Story 3

- [X] T028 [US3] `admin-app/src/hooks/use-resources.ts` の `useResourceList` に `isLoaded`（取得したデータがあるとき `true`）を足す（T022 を緑に）
- [X] T029 [US3] `admin-app/src/components/schedule/external-block-create-dialog.tsx` を直す（T023 を緑に）
  - `resolveStoreResources(isLoaded ? resourceList : undefined, storeId, resourceId)` を使う
  - 欄は `multiple` のときだけ出す。送る枠と、作成できるかの判定には、導いた `resourceId` を使う
  - 説明の文を T023 の文にする
- [X] T030 [US3] `admin-app/src/components/settings/recurring-blocks-tab.tsx` で同じ判断を使う（T024・T025 を緑に）
  - 欄は `multiple` のときだけ出す
  - 導いた `resourceId` を使う所: プレビューの検査、プレビューを消す処理の依存、冪等性のキー、送る内容
  - `derivePreviewInvalid` は、`none` のときに枠が未設定の理由を返す
- [X] T031 [US3] `admin-app/src/components/settings/closures-tab.tsx` に、「終了日を触ったか」の状態を足す（T026 を緑に）
  - 追加の画面で、触っていない間は、開始日を変えると終了日を合わせる
  - リセットのときに、この状態を戻す
  - 編集の画面は今どおり

**Checkpoint**: US3 の試験が緑。

---

## Phase 6: User Story 4 - 予約管理と LINE 友だちの一覧をすっきりさせる (Priority: P2)（PR B）

**Goal**: 1 店舗だけを見ているとき、予約管理に店舗の列が出ない。来店中の絞り込みと CSV のボタンが無い。LINE 友だちの紐付けで、店舗を選ばない。

**Independent Test**: 店舗スタッフとオーナーで、予約管理と LINE 友だちを開く（spec の US4）。

### Tests for User Story 4（先に書き、赤を確かめる）

- [ ] T032 [US4] `admin-app/src/components/schedule/reservation-list-card.test.tsx` に、次を書く（T020 の後）。`showStoreName={false}` のときは、店舗名もリソース名も出ず、店舗の行そのものが無い。渡さないときは、店舗名が出る
- [ ] T033 [P] [US4] `admin-app/src/lib/reservation-search-state.test.ts` に、次を書く。保存された絞り込みの状態が `"checked_in"` や選択肢に無い値なら、復元しない（`null`）。`"confirmed"` と「全ステータス」は復元する
- [ ] T034 [US4] `admin-app/src/pages/reservations.test.tsx` に、次を書く
  - FR-016: 店舗を選んでいると、表の「店舗」の見出し・並べ替えの選択肢・カードの店舗名が無い。全店舗なら出る。店舗を選んだ状態で、店舗で並べ替えた保存値を復元すると、日時の並べ替えになる
  - FR-017: 状態の選択肢に「来店中」が無い。来店中の保存値で開くと、既定の絞り込みになる
  - CSV の URL を作る関数（`buildCsvExportUrl`）のモックを外す
- [ ] T035 [P] [US4] `admin-app/src/pages/reservations-search.test.tsx` の、CSV のボタンを見ている 3 か所を消す。結果が出たあとに CSV のボタンが無いことを書く（FR-018）
- [ ] T036 [P] [US4] `admin-app/src/lib/link-store-id.test.ts`（新規）に、次を書く
  - 店舗が [a, b] で、選んでいるのが b → b
  - `null`・`undefined`・一覧に無い id → a
  - 店舗が 0 件 → `""`
- [ ] T037 [P] [US4] `admin-app/src/pages/line-friends.test.tsx` に、次を書く
  - FR-019: 「紐付け先の店舗」のラベルと欄が無い。複数の店舗でも「既存客に紐付け」が押せて、画面で選んでいる店舗の `storeId` で送る（全店舗のときは先頭の店舗）
  - FR-020: 「未紐付け」「紐付け済み」「すべて」のボタンが無く、一覧は未紐付けだけを取る
  - 店舗の選択を前提にした既存の試験は外す。店舗が 0 件のときに操作を止める試験は残す
- [ ] T038 [P] [US4] 顧客カルテからの紐付けの試験（`admin-app/src/components/customers/` の `link-line-from-card-dialog` の試験）に、店舗の欄が無く、選んでいる店舗の `storeId` で送ることを書く

### Implementation for User Story 4

- [ ] T039 [US4] `admin-app/src/components/schedule/reservation-list-card.tsx` に `showStoreName`（既定は `true`）を足す。`false` のときは、店舗の行を出さない（T032 を緑に）
- [ ] T040 [US4] `admin-app/src/lib/reservation-search-state.ts` を直す（T033 を緑に）
  - 状態の選択肢の一覧（「来店中」を除く）と、「全ステータス」の印を、このファイルに移して export する
  - 復元のとき、状態が一覧に無ければ `null` を返す
- [ ] T041 [US4] `admin-app/src/pages/reservations.tsx` を直す（T034・T035 を緑に）
  - 状態の一覧は T040 から読む
  - 表示している店舗が 1 つに決まっているとき（画面の上の店舗の選択が `null` でないとき）は、次を出さない: 表の「店舗」の見出しとセル、並べ替えの選択肢の「店舗」、カードの店舗名（`showStoreName`）
  - 店舗で並べ替えた状態が残っていたら、日時で並べる。見出しの並べ替えの表示も、それに合わせる
  - 空の表の列の数を合わせる
  - CSV のボタンと、それだけが使う読み込みと処理を消す
- [ ] T042 [P] [US4] `admin-app/src/hooks/use-reservation-search.ts` の `buildCsvExportUrl` を消す。ほかに使う所が無いことを確かめる
- [ ] T043 [P] [US4] `admin-app/src/lib/link-store-id.ts` に `pickLinkStoreId(stores, selectedStoreId)` を実装する（T036 を緑に）
- [ ] T044 [US4] `admin-app/src/pages/line-friends.tsx` を直す（T037 を緑に）
  - 「紐付け先の店舗」の欄と、それを求める案内の文を消す。送る店舗は `pickLinkStoreId` で決める
  - 「読み込み中」「店舗情報がない」ときに操作を止める処理は残す
  - 「未紐付け・紐付け済み・すべて」の切り替えと、その状態を消す。一覧は常に未紐付けで取る。検索の欄は残す
- [ ] T045 [US4] `admin-app/src/components/customers/link-line-from-card-dialog.tsx` を直す（T038 を緑に）。店舗の欄・状態・案内と、古いコメントを消し、`pickLinkStoreId` で送る
- [ ] T046 [P] [US4] `src/admin/line-friends.ts` で、操作の記録の詳しい情報に入れる `storeId` に、1 行のコメントを足す。コードと検査は変えない。コメントの内容は次のとおり
  - 紐付けの操作をしたときに、管理画面が表示していた店舗
  - 紐付け先ではない（お客様は店舗に属さない）
  - 存在の確認のために送られる

**Checkpoint**: US4 の試験が緑。

---

## Phase 7: User Story 5 - 設定・顧客カルテ・Google 連携の重複と分かりにくさを除く (Priority: P3)

**Goal**: リソース一覧に「削除」が無い。カルテでアレルギーが二重に出ない。Google 連携の競合が店舗名で出る。CSV の控えのコードが無い。

**Independent Test**: spec の US5 の受け入れの場面。

### Tests for User Story 5（先に書き、赤を確かめる）

- [X] T047 [US5] PR A。`admin-app/src/components/settings/settings-tabs-status.test.tsx` と `admin-app/src/hooks/use-settings-hooks.test.tsx` の試験を直す（T022 の後）
  - `admin-app/src/components/settings/settings-tabs-status.test.tsx` に、リソース一覧に「削除」のボタンが無く、「無効化」「有効化」が出ることを書く
  - 同じファイルで、リソースの削除の確認を開く試験を、休業日の削除の確認だけにする
  - `admin-app/src/hooks/use-settings-hooks.test.tsx` から、`useResourceDelete` の試験を消す
- [ ] T048 [US5] PR B の試験を足す（T019 の後）。`admin-app/src/components/customers/customer-detail-panel.test.tsx` で、アレルギーの記録があるお客様について、次を書く
  - 「アレルギー」の行が無い
  - 「注意事項」に値が出る
  - 生年月日・性別・紹介者が出る
- [ ] T049 [P] [US5] PR B の試験を足す。`admin-app/src/lib/google-sync-view-model.test.ts` と `admin-app/src/pages/google-sync.test.tsx` に、次を書く。期待値は固定の文字列で書く
  - 競合の一覧で、店舗名が出る
  - 名前が分からない店舗は、今の番号の表示（先頭 8 文字と「…」）になる
- [ ] T050 [P] [US5] PR B の試験を足す。`test/admin-reservations-period.test.ts` の CSV 出力の試験に、次を書いて、今のコードで赤になるのを確かめる
  - 古い設定が残った環境を用意する（保管場所へのつなぎ込みと、有効の値）
  - その環境でも控えを書かない（`put` も、後処理の登録も呼ばれない）
  - 応答の中身とヘッダーは変わらない

### Implementation for User Story 5

- [X] T051 [US5] PR A。`admin-app/src/components/settings/resources-tab.tsx` と `admin-app/src/hooks/use-resources.ts` から、リソースの削除の操作を消す（T047 を緑に）。サーバーの削除の API は残す
  - `admin-app/src/components/settings/resources-tab.tsx` の「削除」のボタンと、確認の画面と、その状態を消す
  - `admin-app/src/hooks/use-resources.ts` の `useResourceDelete` を消す
- [X] T052 [P] [US5] PR A。`admin-app/src/pages/settings.tsx` ほか 3 つのファイルの古いコメントと説明を、実態に合わせて直す。実態は次の 2 つ: 削除は停止にするだけで、行は消えない。将来の予約がある枠は、停止を拒否する。直すファイルは次の 4 つ
  - `admin-app/src/pages/settings.tsx`
  - `src/admin/settings-common.ts`
  - `src/admin/settings-resources.ts`
  - `docs/admin-authz-matrix.md`
- [ ] T053 [US5] PR B。`admin-app/src/components/customers/customer-detail-panel.tsx` の基本情報から、「アレルギー」の行だけを消す（T048 を緑に）
- [ ] T054 [US5] PR B。`admin-app/src/lib/google-sync-view-model.ts` に、店舗名を引く関数を足す（名前が無ければ、先頭 8 文字と「…」）。`admin-app/src/pages/google-sync.tsx` の競合の一覧で使う（T049 を緑に）
- [ ] T055 [US5] PR B。`src/storage/r2-helpers.ts` を中心に、CSV の控えのコードを消す（T050 を緑に）
  - `src/storage/r2-helpers.ts` と `test/r2-helpers.test.ts` を消す
  - `src/routes/admin-api.ts` の読み込みと、CSV 出力の中の控えの処理を消す。応答は、元のストリームをそのまま返す
  - `src/bindings.ts` の、使われなくなる 2 つの型を消す
  - 配備の設定ファイル（`wrangler.jsonc`）は変えない。導入の手順書（`docs/INSTALL.md`）は、保管場所の手順を残し、控えを保管するという説明だけを今の動きに直す（PR B のレビューで足した）

**Checkpoint**: US5 の試験が緑。

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T056 `admin-app/src/` と `src/` で、変えた関数・型・export の呼び出し元を、全部確かめる。消した関数がほかで使われていないこと、型から消した値を渡している所が無いことを見る。そのあと `git diff --check` を通し、`git diff --name-only` に配備と検査の設定ファイルが無いことを確かめる
- [ ] T057 plan.md の「検証」にある、CI と同じ一式を通す（PR A と PR B のそれぞれで）
- [ ] T058 quickstart.md の 2（手元の画面）を、今の予定表と新しい予定表の両方で確かめる
- [X] T059 [P] `specs/008-admin-calendar-ux/tasks.md` の T005 の後半の項目に、1 行を足す（PR A）。詳細の小窓の操作の名前は、spec 009 の「開始時刻を変更」「長さを変更」を使う、という内容

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup（段 1）**: すぐ始められる。
- **Foundational（段 2）**: 段 1 の後。US1、US2 の FR-008、US3 は、この段の後で始める。
- **PR B の作業**（US2 の FR-011、US4、US5 の FR-021〜023）: 段 1 の後なら、段 2 を待たずに始められる（土台を使わない）。
- **Polish（段 8）**: 全部の段の後。

### User Story Dependencies

- **US1**: 段 2 の後。ほかの段に依存しない。
- **US2**: FR-008 は段 2 の後。FR-009〜012 と FR-011 は、ほかの段に依存しない。
- **US3**: 段 2 の後。
- **US4**: 一覧のカードは FR-011（T020）の後（同じファイル）。そのほかは独立。
- **US5**: T047 は T022 の後（同じ試験のファイル）。T051 は T028 の後（同じファイル）。T048・T053 は T019・T021 の後（同じファイル）。

### Within Each User Story

- 試験を先に書き、新しい動作の試験が赤いことを見てから実装する。
- 同じファイルを触る作業は、番号の順に進める。

### Parallel Opportunities

次の 5 つのまとまりは、触るファイルがほぼ重ならないので同時に進められる（重なるのは `admin-app/src/pages/schedule.test.tsx` の試験だけで、別の箇所）。同時に進めるときは、まとまりごとに別の作業ツリーを使う。

1. 作成パネルと予約経路: T004〜T008（段 2 の後）
2. 予約の詳細と変更の画面: T009〜T017（段 2 の後）
3. ブロック・繰り返しブロック・休業日・リソース一覧: T022〜T031、T047、T051、T052（段 2 の後）
4. 一覧のカード・予約管理・LINE 友だち: T018、T020、T032〜T046
5. 顧客カルテ・Google 連携・CSV の控え: T019、T021、T048〜T050、T053〜T055

---

## Parallel Example: User Story 2

```text
# 試験（別のファイルなので同時に書ける）:
T011 開始時刻の変更の画面の試験（reservation-reschedule-dialog.test.tsx）
T012 長さの変更の画面の試験（reservation-duration-dialog.test.tsx）
T013 完了の通知の試験（use-reservations.test.tsx）

# 実装（別のファイル）:
T015 開始時刻の変更の画面（reservation-reschedule-dialog.tsx）
T016 長さの変更の画面（reservation-duration-dialog.tsx）
T017 完了の通知（use-reservations.ts）
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 段 1 と段 2 を終える。
2. US1（オーナーが直接求めた手動予約の整理）を終える。
3. 試験と手元の画面で、US1 を確かめる。

### Incremental Delivery

1. PR A: 段 2、US1、US2 の FR-008〜010・012、US3、US5 の FR-015、文書。
2. PR B: US2 の FR-011、US4、US5 の FR-021〜023。
3. 両方を確認用環境でオーナーが見てから、本番に出す（spec の Assumptions）。

### Notes

- サーバーの API・検査・データ・通知・権限は変えない（FR-024）。
- 配備と検査の設定ファイルは変えない。
- 画面に出る文は、丁寧で自然な日本語にする。

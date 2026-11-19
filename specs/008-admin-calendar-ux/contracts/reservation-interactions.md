# 予約カレンダー操作のAPI契約案

## 文書の位置づけ

この文書は `008-admin-calendar-ux` の提案契約であり、新しいAPI、入力項目、競合制御、Undoは未実装である。現在の動作は、公開ソース `ojungo69/reservation-line-homepage-source` の `main`、commit `3f65c69e64fd3999e415c83c14f5c6dfa928c13d` を読み取って確認した。実装・テスト実行・本番動作確認の結果を示す文書ではない。

ドラッグや長さ変更は、変更候補の作成、サーバー検証、小さな確認画面、明示的な確定の順に扱う。スクロールやパンでは予約を書き換えない。新しい画面のドラッグ、長さ変更、フォームからの変更、Undoは、すべて本書の版を条件とする確定APIを通す。

本文の「必須」は新しい機能を公開する条件を示す。現行APIへ実装済みの保証を追加したという意味ではない。

## 1. 現行契約と提案の差

| 項目 | 現行実装で確認した内容 | この文書の提案 |
| --- | --- | --- |
| 時間変更 | `POST /api/admin/reservations/:id/reschedule`。`idempotencyKey`、`startAt`、任意の `treatmentMinutes` を受け取る | 旧URIを互換用に残し、新画面は後述の `/reschedule/commit` を使う |
| 版の条件 | 旧変更APIに `expectedVersion` はない。サーバーの読取後から書込までの競合をguardするが、古い画面からの送信を拒否する契約はない | `expectedVersion` を必須とし、予約更新SQLで原子的に照合する |
| 未知の入力 | 旧parserは必要な項目を取り出す。追加した `expectedVersion` を必須検証しない | 別URIと契約識別子で新旧を区別する。旧APIへの自動fallbackは禁止 |
| 予約の取得 | `GET /api/admin/reservations?range=date&date=YYYY-MM-DD` の一覧にversionはない。`GET /api/admin/reservations/:id` の詳細にversionがある | 新画面は検証済みのversionを取得してから変更候補を確定する。一覧へのversion追加は任意の最適化であり、値がなければ詳細を取得する |
| 空き候補 | `GET /api/admin/reservations/available-slots?storeId=...&date=...&excludeReservationId=...`。候補列挙は15分間隔。既存予約のリソース・顧客・占有時間をサーバー導出 | 新しいpreviewで任意の5分境界と変更後の占有時間を検証する |
| 担当・店舗 | 変更先のstore/resource/staffは受け取らず、予約の保存済み店舗・リソースを使う | 引き続き固定。別リソース列・別店舗への移動は対象外 |
| 権限 | staffは自店舗の予約を全期間操作可。owner/system_adminは店舗制限なし | 既存権限を維持し、preview・commit・replay・Undoの全経路で再確認する |
| 編集できる状態 | `pending_approval` / `confirmed` かつ `checked_in_at IS NULL`。pendingの既存期限をロックへ引き継ぐ | 同じ条件。移動で承認状態や承認待ち期限を変更しない |
| 占有時間 | 施術時間＋清掃5分。長さ変更の施術時間は5〜235分の5分刻み、占有最大240分 | 移動と長さ変更で意味を分け、清掃を含む終了を常に返す |
| 旧予約の例外 | 保存済みの占有が5分でも開始移動可能。既存予約はinactiveリソースでも時間変更可能 | 両方を維持。新規作成の制約と混同しない |
| 通知 | confirmedかつLINE identityありの開始移動で変更通知をenqueue。開始不変の長さ変更は抑止。pendingでは変更通知をenqueueしない | 条件を維持し、確認画面で予定される通知を示す |
| Google | 変更時はupsertジョブをenqueueし、予約の同期状態をpendingにする | DB保存と非同期同期の結果を分離して表示する |
| 冪等性 | 同じキー・同じhashをreplay。TTLは24時間。現行replayは予約の現在行を読み直し、元の適用結果を固定保存して返す契約ではない | 適用前後と適用versionを保存し、元の成功結果と現在の予約を区別して返す |
| 旧変更APIの拒否 | ドメイン結果 `forbidden` は現状HTTP 400。認証gateや空き候補APIの403とは異なる | 新URIでは認可拒否を403に統一。旧URIのHTTP意味は互換移行として別管理する |

現行の根拠は [予約変更処理][current-reschedule]、[ルートとparser][current-routes]、[HTTP結果対応][current-status]、[予約取得・空き候補処理][current-operations]、[フロントのAPI型][current-types]、[冪等性TTL][current-idempotency] を参照する。

## 2. 操作状態と書込の境界

| 操作・状態 | 許可する処理 | 予約を書き換えるか |
| --- | --- | --- |
| ホイール、トラックパッド、パン、日付移動、表示密度変更 | スクロール、表示更新、必要な読取 | いいえ |
| ドラッグ・長さ変更の途中 | 元予約とは区別した候補を表示。5分境界へ丸める | いいえ |
| ドラッグ・長さ変更の終了 | 候補をpreviewへ渡す。元予約の確定状態は維持する | いいえ |
| preview成功 | 変更前後、施術時間、清掃分、占有終了、通知予定を小さな確認画面へ表示 | いいえ |
| 確認画面でキャンセル、Escape | 候補だけを破棄し、元の予約と操作元へ戻る | いいえ |
| 確認画面で「変更する」 | 一つのcommitを開始する | はい |
| commit送信中 | 同じ予約の新たな変更を止め、操作情報を保持する | 新たな書込を開始しない |
| 通信切断・応答喪失 | 結果不明として元のキーと入力を保持し、同じ操作を再確認する | 新しいキーの書込を開始しない |
| 保存成功 | サーバーが返した現在の予約へ更新し、関連queryを再取得する | 追加書込なし |
| Undo選択 | 保存済み変更の逆候補をpreviewし、もう一度確認する | 確認するまで書込なし |

パンやタッチスクロールの終了を予約ドロップとして扱わない。動きが発生しなかったクリックは既存の詳細表示へ進める。元と同じ日時・占有時間へ戻った候補は送信しない。previewの失敗や取消で、通知・Google同期・ロック履歴を作らない。

確認画面には店舗と担当リソースを読取専用で示す。長さ変更では「施術終了」と「清掃終了・枠の終了」を区別する。変更前後を示した確認を通らず、ドラッグの終了イベントからcommitを呼ばない。

## 3. 新しいpreview API案

**提案URI: `POST /api/admin/reservations/:id/reschedule/preview`**

POSTというHTTP methodを使うが、ここで行うのは検証と候補計算だけである。予約、slot lock、customer lock、冪等成功記録、通知ジョブ、Google同期ジョブを作成・更新しない。previewは予約枠を確保せず、優先権や有効期限付きの枠を発行しない。

### 提案する入力

```ts
type ChangeIntent =
  | { kind: "move"; startAt: string }
  | { kind: "resize"; treatmentMinutes: number }
  | { kind: "undo"; inverseOfOperationId: string };

type PreviewRequest = {
  contractVersion: "calendar-interactions-v1";
  expectedVersion: number;
  intent: ChangeIntent;
};
```

これは提案するデータ形状であり、現行リポジトリの型ではない。外部入力は実行時に検証する。`expectedVersion` は正の安全な整数とし、取得した予約のversionをそのまま送り、クライアントで増減して作らない。intentは一種類だけとし、moveに長さ変更を混在させない。`storeId`、`resourceId`、`staffId`、`endAt`、任意の通知抑止指定は受け付けない。

moveは保存済み占有時間を保って開始を移動する。resizeは保存済み開始を保って施術時間を変更する。undoは第8節に従って保存済みの適用前スナップショットから逆変更を計算する。

### 提案する返却内容

成功時は `ok: true`、契約識別子、`reservationId`、検証対象の `version`、正規化したintentと、次を返す。

- `before` と `after`。各々の `startAt`、施術終了 `treatmentEndAt`、清掃込みの `endAt`、`occupancyMinutes`、`treatmentMinutes`。
- 変更しない店舗、担当リソース、承認状態。
- `notificationPlan`。`time_changed` または `none` と、その理由。理由は `pending_approval`、`no_line_identity`、`start_unchanged` など、実際の条件に対応させる。
- `calendarPlan: "enqueue_upsert"`。Google反映完了を意味しない。
- `previewFingerprint`。正規化した変更前後、予約version、通知・同期予定に対応する照合値。
- `commitDeadline`。このpreviewに基づくcommitを受け付ける期限（サーバーの時刻）。サーバーが発行時刻から短い一定時間で決める。`previewFingerprint` は `commitDeadline` と発行時刻を含めて署名などで保護し、現在の予約内容に依存せずサーバーが検証できるようにする（照合専用の要求でも使う）。期限は予約UPDATEの成立条件としてDBの時刻で判定する（第4章の手順5）。

`previewFingerprint` は、確認した内容とcommit時の計算結果を照合するための値である。認可や空き枠保証の代わりにしない。サーバーはクライアントの `after` や通知予定をそのまま信用せず、保存済み予約とintentから計算する。署名や保存方式は実装設計で決め、単なる照合値を予約枠のhold tokenと呼ばない。

保存済み占有5分の旧予約は、moveでは占有5分を保持し、計算上の施術部分0分をそのまま区別して返す。入力制約に合わせて勝手に占有10分へ伸ばさない。新しいresize入力に0分を許可する意味ではない。

### 5分単位の検証

previewは候補の全占有範囲 `[startAt, endAt)` を5分単位で検証する。終端そのものを重複枠に含めない。検証対象は次の通り。

1. 操作者の現在の権限、予約の店舗、対象version、変更可能な状態、来店前であること。
2. 開始の5分境界、秒・ミリ秒が0であること、長さ変更の範囲と刻み。
3. 開始を動かす場合は変更先が未来であること。開始不変の長さ変更は開始後も許可する既存ルールを維持する。
4. 清掃5分込みの全占有が、店舗タイムゾーン上の同じ日・一つの有効な営業時間帯に収まること。臨時休業に重ならないこと。
5. 自予約のロックだけを除外したリソースロック、顧客時間ロック、他の外部ブロックとの重複。
6. 書込側が適用する同電話番号hashの競合なども、同じ適用条件で検証すること。既存の候補取得が検出しない競合を見落としたまま「検証済み」としない。それでもpreview後の競合は発生し得るため、commitで再検証する。

期限切れpendingロックを時刻だけで無視しない。実際に解放されたDB状態を使う。inactiveなリソースにある既存予約は、現行変更処理と同様に検証対象にできる。顧客向けのメンズメニュー受付制限を、管理者の手動変更へ追加しない。

現行の `available-slots` は15分おきの候補を返し、rescheduleモードでは保存済みの長さを使う。`excludeReservationId` と変更後の `durationMinutes` を併記しても、本提案のresize検証にはならない。5分候補を15分候補の間から補間して「検証済み」と表示しない。preview成功後でも、commit直前の別予約や設定変更によって保存は失敗し得る。[現行の空き候補処理][current-operations]

## 4. 版を条件とするcommit API案

**提案URI: `POST /api/admin/reservations/:id/reschedule/commit`**

```ts
type CommitRequest = PreviewRequest & {
  idempotencyKey: string;
  previewFingerprint: string;
  commitDeadline: string; // previewの返却値。previewFingerprint で改ざんを検出する
};
```

このURIでは `expectedVersion`、正しい契約識別子、冪等キー、preview照合値、`commitDeadline` を必須とする。省略・型不一致・未知のintent・別店舗や別リソースを指定する追加項目を拒否する。旧画面のフォームは旧URIを使用し続けられるが、新画面のフォームもdrag/resizeと同じcommitに統一する。

### 処理順序

1. **認証と入力形式の検証。** 既存の認証・CSRF・変更回数制限の経路を維持する。ISO表現を同じinstantへ正規化し、要求hashは契約識別子、予約ID、expectedVersion、intent、preview照合値、`commitDeadline` から作る。再送時に変わり得る現在の予約行からhashを作り直さない。
2. **現在の認可。** 対象予約の店舗を取得し、現在も有効な操作者か、staffが自店舗の対象を扱っているかを確認する。成功済みキーでも、認可より先に結果や予約情報を返さない。Undoの元操作も同じ対象予約・許可された店舗に属することを確認する。
3. **冪等結果の解決。** 同じキー・同じhashの成功記録があれば、新たな状態遷移や通知を行わずreplayする。別hashなら `idempotency_conflict`、有効な処理中記録なら `idempotency_in_progress` を返す。認可が通っていて成功済みなら、すでに進んだ予約versionを理由に元操作のreplayを拒否しない。サーバーの切り替え（plan.md「導入制御と配備の制約」）がオフなら、ここまでの応答（replay・`idempotency_conflict`・`idempotency_in_progress`）以外を `feature_disabled` として終え、手順4以降へ進まない。Undoは同じcommitを使うので同じ判断に従う。previewは冪等キーを持たないため、認可の後に `feature_disabled` を返す。
4. **新しい操作の検証。** 未適用の場合だけ、まず `commitDeadline` を判定し、過ぎていれば `preview_stale` として書き込まない（再送も同じ）。続いて最新予約のversionをexpectedVersionと照合し、状態、未来時刻、営業帯、休業、全占有範囲、顧客競合を検証する。previewと通知予定を含む確認内容が変わっていれば `preview_stale` とし、再確認を求める。日時・占有が全く変わらない要求は `no_change` として副作用なしで終了する。
5. **D1の原子的な変更。** batchの先頭で既存の `adminWriteGuard` を実行する。冪等キーをclaimし、予約UPDATEの条件へ `version = expectedVersion`、対象店舗、許可状態、`checked_in_at IS NULL`、DBの時刻が `commitDeadline` より前であることを含める。手順4の後に待たされ、期限を過ぎてから実行されたbatchは適用されない。更新が1件適用されたと確認してから旧ロック解放と新ロック作成を進める。認可guardをUPDATEとその `changes()` を読むguardの間へ挟まない。検証後の休業・設定変更や競合にも対応するDB側の検証を維持・補完し、不一致ではbatch全体をrollbackする。
6. **同じbatch内で結果を保存。** ロック・顧客ロック・監査履歴に加え、適用前後、`operationId`、`beforeVersion`、`appliedVersion`、通知・Googleジョブの作成結果、冪等成功記録を保存する。成功結果の保存方式には追加実装が必要であり、既存の `target_id` だけで十分とはしない。
7. **DB確定後の返却と非同期処理。** 既存のqueue起動経路を使う。外部配信完了を待ってDB成功を取り消したり、同期失敗を理由に予約を元時刻へ自動変更しない。

現行処理は状態・営業時間等を検証した後に冪等記録を確認している。本提案では、認可を維持した上で、**新しい操作向けのversion・状態検証より前に成功済みreplayを解決する順序へ新経路を設計する**。これは未実装の変更点である。成功応答喪失後に自分の変更でversionが増えたことを、再送の失敗理由にしないために必要となる。[現行の変更処理][current-reschedule] [既存の書込認可guard][current-auth-guard] [遷移文の順序][current-transitions]

旧APIの開始移動用hashを新形式に置換しない。新契約は識別子を含むhashとキーの識別方法を持ち、旧操作の24時間TTL内のreplayを維持する。具体的なテーブル・カラム追加は実装設計で決めるが、成功結果とジョブ作成の原子性は必須とする。

### 提案する成功応答

| フィールド | 意味 |
| --- | --- |
| `contractVersion` | `calendar-interactions-v1`。新契約として検証されたことを示す |
| `ok` / `replayed` | DB操作の成功と、その応答が既適用操作の再提示であるか |
| `operationId` | 保存済みの一回の変更を指す識別子 |
| `change.before` / `change.after` | この操作が適用した前後の確定値。replay時も変えない |
| `change.beforeVersion` / `change.appliedVersion` | この操作が読んだ版と、更新して確定した版 |
| `reservation` | 応答時に読み取った現在の予約。`id`、`version`、状態、固定の店舗・リソース、開始、終了、占有時間を含む |
| `effects.notification` | この操作で通知が不要だったか、通知ジョブを作成したか。配信状況が分かる場合は別項目で示す |
| `effects.calendar` | この操作のupsertジョブ作成結果と、取得できる範囲の同期状況 |

通常は `change.appliedVersion === reservation.version` だが、replayまでに別の変更が入れば異なる。画面は現在の `reservation` を表示し、古い `change.after` で現在値を上書きしない。`effects` のジョブ作成と配信・同期完了を同じ成功フラグへまとめない。

## 5. エラー応答と再取得

以下のHTTPコードと新しいreason名は**新URIの提案**である。旧URIの実装済みコードを変更した表ではない。

| HTTP | 提案reason | クライアントの動作 |
| --- | --- | --- |
| 400 | `invalid_request` / `unsupported_contract` | 新契約の入力を修正。旧writeへfallbackしない |
| 401 | 認証gateの既存reason | ログイン回復まで変更を止め、未確定操作の情報を失わない |
| 403 | `forbidden` | 当該操作を止める。結果・競合相手の個人情報を返さない |
| 404 | `not_found` または新URI未対応 | 最新状態を取得。新URI未対応なら新しい変更機能を無効にする |
| 409 | `version_conflict` | 権限内で取得できる最新予約へ表示を更新。新しい版を自動採用して再送しない |
| 409 | `invalid_transition` | 来店・完了・取消等の最新状態へ更新し、変更候補を確定しない |
| 409 | `preview_stale` | 変更前後・通知予定を再計算し、改めて確認する。`commitDeadline` を過ぎた要求にも返す（元の操作の結果は第6章の照合専用の要求で確かめる） |
| 409 | `slot_unavailable` / `customer_time_conflict` | 予約・空き・ブロックを再取得し、別候補を選べる状態へ戻す |
| 400 | `invalid_time` / `outside_business_hours` / `store_closed` | 候補が保存されていないことと該当理由を表示。必要な設定・空きを再取得 |
| 409 | `no_change` | 書込・通知なしとして候補を終了する |
| 409 | `idempotency_conflict` | 同じキーを別入力へ使っている不整合を示す。新キーでの自動再送は禁止 |
| 409 | `idempotency_in_progress` | 同じキー・同じ入力を保持。案内された待機後に結果を再確認 |
| 404 | `feature_disabled` | 新しい変更機能を無効にして閲覧を続ける。この応答を返した要求は、予約・ロック・予約履歴・通知と同期のジョブ・冪等記録を書き込んでいない（既存の認証と回数制限の記録・応答はそのまま）。結果不明の操作の再送でこの応答を受けても、元の操作が保存されたかは示さない（第6章）。旧writeへfallbackしない |
| 409 | `operation_expired` / `undo_not_available` | 元操作の保管期限やUndo条件を説明し、勝手に逆変更を実行しない |
| 500または503 | `write_failed` 等 | 明確に未適用と断定できなければ結果不明として扱い、同じキーで確認する |

認可後の競合応答には、返却可能な場合のみ最新の予約versionと状態を含める。詳細な競合相手の名前、電話番号、他店舗の予約内容をエラーに載せない。ロールバック済みと返せるエラーは予約・ロック・履歴・ジョブを一切残さないことを保証する。HTTP 500や接続切断だけを「未保存」の証拠にしない。

## 6. 応答喪失、replay、結果不明

一つの確定操作は一つの冪等キーと正規化済み入力に対応する。成功を確認するまで、その予約について別の確定操作・Undoを重ねない。ダイアログを閉じる、日付を変える、画面を再描画することでキーを失わない。再読み込み後の回復を提供する場合も、元の入力とキーを復元して同じ操作を確認する。認証主体の切替時は以前の操作を自動送信しない。

通信切断後に元表示へ描き直すだけで「保存を取り消した」と表示しない。結果不明のまま別キーを作り、同じ移動を新しい操作として実行しない。回復操作は、同じcommitへ同じキー・同じ入力を送り、成功済みならreplay、未適用なら条件付き変更、処理中なら待機という結果を得る。

成功replayでは既存のロック・通知・同期ジョブを再作成しない。要求時のversionが現在より古くても、そのキーの成功記録が一致し、現在の認可が通れば元操作の結果を返せる。現在の予約がさらに更新・完了・取消されている場合は、元操作の成功と現在状態を別々に返す。

切り替えの停止を挟んでも、回復操作は同じcommitへ同じキー・同じ入力を送る。成功記録があればreplay、処理中なら `idempotency_in_progress`、同じキーの別入力なら `idempotency_conflict` が返り、これらの応答の扱いは停止の前と変えない。それ以外は `feature_disabled` が返る。`feature_disabled` が保証するのは、その再送が予約・ロック・予約履歴・通知と同期のジョブ・冪等記録を書き込まなかったことだけである。停止の前の版で受け付けた元の要求が、冪等キーを確保する前の段階でまだ処理を続けている場合があり、後から確定し得るため、元の操作を未保存と断定しない。画面は「変更機能が停止中で、この操作が保存されたかは確認できていない」と示して最新の予約を表示し、同じキー・同じ入力を結果不明のまま保持し、下の手順で結果を確定させる。停止中に新しい操作として再実行せず、旧画面の書込へ移し替えて自動送信もしない。commit送信中か結果不明の操作が残っている間は、切り替えのオフを知っても今の画面へ差し替えない（plan.md「導入制御と配備の制約」）。

冪等記録は少なくともサポートする再送期間を保持する。現行TTLは24時間であり、保存期間延長や成功結果の保持には追加設計が必要となる。結果不明は次の手順で確定させる。予約の変更は各要求の中の原子的な書込だけで行い、後から適用する経路を持たない。期限は予約UPDATEの成立条件であり（第4章の手順5）、期限を過ぎてから実行されたbatchは、手順4を通った後に待たされた要求でも適用されない。D1は同じデータベースへのbatchと問い合わせを1件ずつ順に実行するので、期限の後に始まったbatchが確定することはない。期限の前にUPDATEが成立したbatchは、そのbatchの中で確定する。

結果不明の間、画面は同じcommitへ同じキー・同じ入力を再送してよい（未適用で期限前なら条件付き変更になる）。`preview_stale`（期限切れ）か `feature_disabled` を受けたら、元の操作の結果は照合専用の要求（提案URI: `POST /api/admin/reservations/:id/reschedule/reconcile`）で確かめる。端末の時計で期限の前後を判断しない。照合専用の要求は元の入力（冪等キー、`commitDeadline`、照合値を含む）を送り、切り替えの状態に関係なく、どの場合も書き込まない。サーバーは現在の認可の後に照合値を検証し、`commitDeadline` と発行時刻が元のpreviewのものであることを、現在の予約内容に依存せず確かめる。検証できない入力には `invalid_request`、同じキーの別hashには `idempotency_conflict` を返し、結果の確定に使わない。検証できた入力について、書込と同じ一次データベースへの単一の問い合わせでDBの時刻と冪等記録を同時に読み（読み取りレプリカの遅れや、問い合わせの間に確定した書込を見落とさない）、次のどれかを返す。

| 結果 | 条件 | 画面の扱い |
| --- | --- | --- |
| `applied` | 同じキー・同じhashの成功記録がある（replayと同じ内容） | 保存済みと表示する |
| `in_progress` / `pending` | 処理中の記録がある、またはDBの時刻がまだ期限前 | 待って照合を繰り返す |
| `not_applied` | DBの時刻が期限を過ぎ、成功記録が無く、冪等記録の保持が保証される期間（previewの発行から保持時間が過ぎるまで）の中にある | 未適用と確定して表示する |
| `unknown` | 保持が保証される期間を過ぎて判定できない | 「確認できなかった」と示し、最新の予約を取得する |

元のcommitの成功応答かreplayを受けるか、照合専用の要求で `applied`・`not_applied`・`unknown` のどれかを受けるまで、画面の差し替えを保留する。期限を過ぎた後に書込は確定しないため、`unknown` で保留を解いてよい。通信できないまま保持期間を過ぎた不明操作は、新しい操作へ自動変換しない。同じ日時へ見えるという理由だけで、元操作が成功したと断定しない。

## 7. 通知とGoogle同期

| 変更 | 既存ルールを維持する通知予定 | Google |
| --- | --- | --- |
| confirmedの開始移動、LINE identityあり | 顧客への時間変更通知をenqueue | upsertをenqueue |
| confirmedの開始移動、LINE identityなし | 顧客LINE通知なし | upsertをenqueue |
| pending_approvalの開始移動 | 顧客への時間変更通知なし。承認状態維持 | upsertをenqueue |
| 開始不変の長さ変更 | 顧客への時間変更通知を抑止 | upsertをenqueue |
| 無変更候補・preview取消・拒否・rollback | 作成しない | 作成しない |

移動の確認画面は必要な通知を知らせ、任意に抑止するスイッチを追加しない。preview後に承認状態やLINE連携条件が変わり通知予定が変わる場合は、commitで再確認が必要になる。

保存直後の文言は「予約を変更しました」とし、必要に応じて「通知を送信待ち」「Googleへ同期中」を別表示する。通知失敗・同期失敗には既存の連携確認導線を使う。予約の保存失敗、通知の配信失敗、Google同期失敗を同じ「変更失敗」にまとめない。

ジョブがqueuedであっても、確認画面やUndoからそのジョブを取り消せるとは約束しない。すでに送信した通知、外部サービス側の履歴、完了した同期を取り消したことにもできない。非同期ジョブの取消は本契約に含めない。

## 8. Undoは条件付きの逆変更

Undoはローカルの表示巻戻しではなく、保存済み操作を参照する新しい変更である。新しい冪等キー、権限確認、preview、明示的な確認、commitを必要とする。Undo専用にDBの履歴や通知を削除しない。

1. UIが成功を確認した最後の操作を候補にする。結果不明の操作はUndoしない。
2. `inverseOfOperationId` が指す保存済み操作から変更前の開始・占有時間を取得する。クライアントが任意に組み立てた過去値をそのまま復元しない。
3. 現在の予約versionと要求のexpectedVersionが、元操作の `appliedVersion` に一致することを要求する。後続の変更があれば逆変更しない。強制適用や新しいversionへの自動差替えは提供しない。
4. 元の時間が現在では過去、枠が他予約で埋まった、来店・完了・取消済み、権限が失われた、といった場合は通常の変更ルールで拒否する。時間と状態を無視した復元権限を作らない。
5. 逆変更の通知予定を再計算して確認画面へ示す。confirmedかつLINE連携ありの開始戻しでは、再び時間変更通知が必要になる。長さだけ戻す場合は既存の開始不変ルールを適用する。
6. 成功時はversionを増やし、必要な通知・Google upsertを新たにenqueueし、新しい監査記録を残す。元操作の通知を消したと表示しない。

占有5分の旧予約を長さ変更した後に戻す場合は、元操作の信頼できる変更前スナップショットの占有5分へ戻せる互換処理が必要である。任意入力として `treatmentMinutes: 0` を許す方法では実装しない。この例外を実装できない段階では、該当するUndoを明示的に利用不可にし、別の長さへ黙って丸めない。旧予約の開始移動自体は引き続き占有5分を保つ。

Undoの提示期間は画面仕様で定めるが、期間内でも成功は保証しない。operation記録の保持期間内で、現在の版と業務制約が一致する場合だけ実行する。

## 9. 互換導入順と公開ゲート

1. **サーバーの準備。** 適用結果の保存、原子的なversion条件、既存認可guard、同じキーのreplay、5分preview、逆変更を実装・検証する。旧URI、旧入力、旧hash、TTL内の旧replayを維持する。
2. **読取・新URIの先行公開。** 新APIを利用できる状態にし、version・契約識別子・構造化結果を返す。旧clientは従来どおり動作できる。旧clientの変更も予約versionを進めるため、新clientは古い版での保存を拒否できる。
3. **新画面のフォームを接続。** フォームからの移動・長さ変更も新commitを使い、競合・結果不明・replayの動作を確認する。新画面の一部だけを旧writeへ戻さない。
4. **直接操作を有効化。** 新しいpreviewと条件付きcommitの対応が確認され、以下の受入条件が通ってからdrag/resizeを公開する。直接操作とUndoの公開前にサーバー側の版条件が必須となる。
5. **Undoを有効化。** 適用結果の保管、逆変更の版条件、再通知の説明、旧占有5分の扱いまで確認して公開する。
6. **旧経路を段階移行。** 旧画面・旧clientの利用と互換期間を確認した後に、旧経路の移行・廃止を別途判断する。本仕様だけで旧APIを廃止しない。

本番では、サーバーの切り替えがオンになるまで、previewは認可の後に `feature_disabled` を返し、commit（Undoを含む）は第6章の照合の応答だけを返して、それ以外は `feature_disabled` を返す。照合専用の要求は書き込まないため、切り替えに関係なく使える。

新APIが404/405、未対応契約、必要なversion・結果項目の欠落を返した場合、変更機能は無効にして閲覧を続ける。旧 `/reschedule` へ自動fallbackしない。preview直後にサーバーが旧版へrollbackした場合も同様とする。機能フラグだけで旧parserの読み捨てを防げると考えず、別URIと必須検証を実際の防止境界にする。

## 10. 受入条件

次の条件は新しい機能の検証項目であり、現時点のテスト合格を示すものではない。

| ID | 条件 |
| --- | --- |
| API-01 | ホイール、トラックパッド、パン、日付移動、表示密度変更だけでは予約変更APIを呼ばず、ロック・履歴・通知・同期ジョブが増えない |
| API-02 | drag/resize終了ではpreviewと確認だけを行い、利用者の明示的な確定前にcommitしない。取消・Escapeで副作用を残さない |
| API-03 | 新commitはexpectedVersion欠落を拒否する。新URI未対応・旧サーバーへのrollback時に旧writeへfallbackしない |
| API-04 | 同じversionから二人が別の変更を送ると一方だけ成功する。敗者は `version_conflict` となり、ロック・通知・同期ジョブを残さず最新予約を表示する |
| API-05 | preview成功後に別予約が枠を取った場合、commitが全占有を再検証して拒否し、元の予約・ロックを維持する |
| API-06 | 09:40等の5分境界を検証でき、細かすぎる秒・分、235分超の施術、5分刻みでない長さを拒否する。15分候補間を検証済みとして補間しない |
| API-07 | 施術と清掃5分を分け、清掃だけが次予約・休業・閉店と重なる場合も拒否する。終端が次枠の開始と一致する半開区間は不必要に重複扱いしない |
| API-08 | 開始不変の施術延長・短縮は開始後も可能だが、開始を過去へ移動できない。来店済み、完了、取消等を変更できない |
| API-09 | pendingの移動後もpendingであり、既存の承認待ち期限を延長せず、顧客への時間変更通知を新規作成しない。承認は独立した既存操作とする |
| API-10 | staffの他店舗preview・commit・replay・Undoを拒否する。送信中の権限剥奪でもbatch全体を止める。owner/system_adminの既存店舗権限は維持する |
| API-11 | resource/store/staff横断の要求を新APIで拒否する。リソース列をまたいだ見た目だけの移動を確定扱いにしない |
| API-12 | inactiveリソースの既存予約を時間変更できる。占有5分の旧予約のmoveで占有を勝手に延ばさない。新規作成のactive制約は緩めない |
| API-13 | ドロップが元の開始・占有と同じなら送信しない。APIへ同内容が到達しても `no_change` でロック履歴・通知・同期ジョブを増やさない |
| API-14 | DB成功後に応答を失っても、同じキー・入力の再送か照合専用の要求で成功を確認できる。自分の更新でversionが進んだことを理由にreplayを拒否せず、ジョブを重複作成しない |
| API-15 | 成功後に別操作が入った状態でreplayすると、元操作の適用結果と現在予約を別返却する。UIは現在予約を古い成功値へ巻き戻さない |
| API-16 | 同じキーで別入力は `idempotency_conflict` となる。処理中・通信切断・5xx時に新キーを自動発行しない。旧形式キーのTTL内replayも回帰しない |
| API-17 | 旧成功記録や新操作の成功結果を、現在認可がない利用者へreplayしない。エラーに他店舗や競合相手の個人情報を含めない |
| API-18 | confirmedかつLINE連携ありの開始移動だけが必要な時間変更通知を作成する。開始不変の長さ変更は通知抑止を維持し、Google upsertは作成する |
| API-19 | DB保存成功、LINE送信待ち・失敗、Google同期待ち・失敗を区別して表示する。非同期失敗を予約の自動巻戻しに結び付けない |
| API-20 | Undoは元操作のappliedVersionと現在版が一致する場合だけpreview・再確認・commitできる。後続変更、埋まった元枠、過去移動、状態変更、権限喪失時は適用しない |
| API-21 | Undoの開始戻しが通知対象なら再通知を明示して確認する。既送信通知や既存ジョブの取消を約束せず、逆変更の監査・同期を新たに記録する |
| API-22 | 占有5分の旧予約へUndoする場合は保存済みの正確な値を使う。対応前は該当Undoを利用不可にし、任意の0分施術入力や10分への丸めで代用しない |
| API-23 | previewに予約枠の保持効果がなく、commitが原子的に再検証することを確認する。preview照合値の不一致は再確認に戻し、暗黙に別候補を保存しない |
| API-24 | 新画面のフォーム、drag/resize、Undoが同じ条件付きcommitを使う。キー・入力・結果不明状態はダイアログ開閉や日付切替で失われず、認証主体の変更時に自動再送されない |
| API-25 | サーバーの切り替えがオフのとき、previewは現在の認可の後に `feature_disabled` を返す。commit（Undoを含む）は現在の認可の後、成功済みreplay・`idempotency_conflict`・`idempotency_in_progress` 以外を `feature_disabled` で終える。予約・ロック・履歴・通知と同期のジョブ・冪等記録を残さない。停止の前に適用済みだった操作は、同じキー・同じ入力の再送で結果を確認でき、ロック・通知・同期ジョブを再作成しない。停止の前に未適用だった操作の再送は、停止中に適用されない。元の commit が冪等記録を作る前に停止と再送を挟み、その後に元の commit が確定する場合も試す。再送は `feature_disabled` で予約・ロック・予約履歴・通知と同期のジョブ・冪等記録を変更せず、画面は元の操作を未保存と表示しない。後の再確認で replay を受け、保存済みと表示する。画面の試験では、応答の喪失、`/me` のオフの反映、差し替えの保留、元の commit の遅延確定、同じキーでの replay、その後の今の画面への差し替えまでを通す。commit送信中に `/me` がオフを返し、その後に応答の喪失が分かる順序でも、差し替えを保留したまま同じキー・同じ入力で replay まで進める。停止の直前に受理された再送の応答も失われる場合、期限の直前に手順4を通った要求をD1の書込の前で遅らせる場合（期限後に実行されたbatchは適用されず、照合専用の要求は `not_applied` を返す）、期限の前にUPDATEが成立したbatchが期限の後に確定する場合（照合専用の要求は `applied` を返す）、期限を改変した入力や同じキーの別入力での照合（結果の確定に使わない）、端末の時計が進んでいる場合、オフを確かめた後に再びオンになる場合、保持期間の境目（`unknown` を返し、保留を解く）も試す。照合専用の要求はどの場合も書き込まない。既存の認証と回数制限はそのまま働く。旧画面の保存は停止の前後で変わらない |

既存の回帰確認先は `test/admin-reschedule-reservation.test.ts`、`test/admin-available-slots.test.ts`、`test/admin-create-reservation.test.ts`、`admin-app/src/hooks/use-reservations.test.tsx`、`admin-app/src/lib/reschedule-idempotency.test.ts`、`admin-app/src/components/schedule/reservation-duration-dialog.test.tsx`、`admin-app/src/pages/schedule.test.tsx`。新URIの入力検証、二つのclientによる競合、replayと権限変更、実入力のスクロール・drag競合には追加の検証が必要となる。

## 参照した現行実装

リンクはすべて監査時のcommitに固定している。提案の実装時には差分を確認する。

- [予約変更処理][current-reschedule]
- [ルート、旧request parser、空き候補の予約導出][current-routes]
- [HTTP結果対応][current-status]
- [予約一覧・詳細と空き候補の生成][current-operations]
- [予約・詳細のフロントエンド型][current-types]
- [占有・清掃・5分ロックの共通定義][current-slots]
- [営業時間・臨時休業の検証][current-hours]
- [遷移文、ロック置換、履歴の順序][current-transitions]
- [書込認可の再確認][current-auth-guard]
- [既存の変更フォームと同時刻送信防止][current-dialog]
- [既存の長さ変更フォーム][current-duration-dialog]
- [既存の冪等キー保持][current-key]
- [既存の冪等性TTL][current-idempotency]
- [既存の予約変更APIテスト][current-tests]

[current-reschedule]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/admin/reservation-reschedule.ts
[current-routes]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/routes/admin-api.ts
[current-status]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/routes/shared.ts
[current-operations]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/admin/operations.ts
[current-types]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/admin-app/src/types/api.ts
[current-slots]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/reservations/slot-times.ts
[current-hours]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/reservations/business-hours.ts
[current-transitions]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/reservations/transitions.ts
[current-auth-guard]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/admin/write-authorization.ts
[current-dialog]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/admin-app/src/components/schedule/reservation-reschedule-dialog.tsx
[current-duration-dialog]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/admin-app/src/components/schedule/reservation-duration-dialog.tsx
[current-key]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/admin-app/src/lib/reschedule-idempotency.ts
[current-idempotency]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/admin/settings-common.ts
[current-tests]: https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/test/admin-reschedule-reservation.test.ts

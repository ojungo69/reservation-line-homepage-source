# 1店舗から導入する

この手順は新規の、運営者自身が管理する環境用です。既存の本番 DB や別事業者の設定を流用しません。初期 SQL は空の DB だけを対象とします。既存の店舗・管理者・顧客・予約がある場合や再実行時は、最初の INSERT が `NOT NULL constraint failed: stores.name` で拒否します。既存データの更新や owner の再有効化には使いません。導入作業は「ローカル模型」「自分の外部アカウント」「実予約前の確認」の3段階です。各段階の合格は次の段階の代わりになりません。

## 1. 架空の1店舗をローカルで確認する

Node.js 24、npm、sh 互換シェル（Windows では WSL 等）を用意し、新しい checkout で作業します。以下は同じ `.wrangler/oss-install` を migrations、bootstrap、`wrangler dev` に指定します。このパスと `.dev.vars` は gitignored です。

```sh
set -eu
test ! -e .dev.vars
test ! -e .wrangler/oss-install
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix admin-app
cp .env.example .dev.vars
printf '\nGOOGLE_LIVE_AVAILABILITY_ENABLED=false\n' >> .dev.vars
npm run cf:types
mkdir -p .wrangler
cp seeds/bootstrap.sql .wrangler/bootstrap.sql
./node_modules/.bin/wrangler d1 migrations apply DB --local --persist-to .wrangler/oss-install
./node_modules/.bin/wrangler d1 execute DB --local --persist-to .wrangler/oss-install --file .wrangler/bootstrap.sql
./node_modules/.bin/wrangler d1 execute DB --local --persist-to .wrangler/oss-install --command "SELECT COUNT(*) AS n FROM stores"
npm run admin:build
./node_modules/.bin/wrangler dev --local --persist-to .wrangler/oss-install --port 8787
```

`.env.example` に `GOOGLE_IMPORT_ENABLED=false` はありますが、`GOOGLE_LIVE_AVAILABILITY_ENABLED` はありません。コピーした `.dev.vars` に `GOOGLE_LIVE_AVAILABILITY_ENABLED=false` を追記してから起動します。`wrangler.jsonc` の初期値は両方 true です。既存の `.dev.vars` やローカル状態がある場合は、上書きせず別の新しい checkout・保存先を使ってください。ローカルでは架空の Calendar ID と実際の Google 照会を混ぜないでください。

別の端末で `http://127.0.0.1:8787/api/health` が `ok: true` / `status: pass`、`/api/public/reservation-options` が `ok: true`、`stores` が1件で、サービス・リソース・営業時間もその店舗に紐づくことを確認します。DB の `COUNT(*)` も1です。予約の作成、外部通知、Google 同期はここでは試しません。`seeds/dev.sql` は4店舗の fixture なので、この手順には適用しません。

`seeds/bootstrap.sql` の owner は `owner@example.invalid` という仮の登録先で、`access_subject` は初回紐付け待ちです。ローカルの `/admin` ページ表示と `/api/admin/me` には開発用の例外があります。他の管理 API や公開予約の認証を通す証拠にはならず、Access で確認された実際の owner がログインした証拠にもなりません。初回 owner 紐付けは第2段階で検証します。

## 2. 自分の外部アカウントと公開先を用意する

`wrangler.jsonc` は導入完成品ではありません。D1 と KV の ID はゼロ値、Worker・bucket 等の名前と環境変数はサンプルです。自分の Cloudflare アカウント内に新しいリソースを作り、バインディングと実際の ID・名前を一致させます。別事業者の `.env.*`、Secret、DB dump、運用設定をコピーしないでください。[Wrangler の設定](https://developers.cloudflare.com/workers/wrangler/configuration/)と[D1 のローカル・リモート操作](https://developers.cloudflare.com/d1/wrangler-commands/)を確認してください。

この手順では queue 名を変更しません。`reservation-google-sync`、`reservation-line-notifications`、`reservation-google-sync-dlq`、`reservation-line-notifications-dlq` を自分のアカウント内に新規作成し、producer と consumer に同じ名前を指定します。アプリは固定の queue 名で処理を振り分けるため、任意名では処理できません。同名の queue を別アプリが使用中なら混用せず、環境の分離を先に設計してください。

自分の Cloudflare アカウントへログインし、`whoami` で対象を確認してから作成します。複数アカウントを使う場合は `wrangler.jsonc` の `account_id` も対象に固定してください。以下の D1・bucket 名は自分の新規インストール用に選び、返された ID と名前を設定へ反映します。queue 名は上記の制約を守ります。

```sh
set -eu
./node_modules/.bin/wrangler login
./node_modules/.bin/wrangler whoami
./node_modules/.bin/wrangler d1 create reservation-system-db
./node_modules/.bin/wrangler kv namespace create CACHE
./node_modules/.bin/wrangler r2 bucket create reservation-system-storage
./node_modules/.bin/wrangler queues create reservation-google-sync
./node_modules/.bin/wrangler queues create reservation-line-notifications
./node_modules/.bin/wrangler queues create reservation-google-sync-dlq
./node_modules/.bin/wrangler queues create reservation-line-notifications-dlq
```

| 設定 | このアプリでの用途 | 導入時の扱い |
| --- | --- | --- |
| `DB` / D1 | 店舗、管理者、予約の正本 | 必須。新規 DB にすべての migration を適用 |
| `ASSETS` / Workers Static Assets | 公開画面と管理 SPA | 必須。`npm run admin:build` 後に配備 |
| `GOOGLE_SYNC_QUEUE`、`LINE_NOTIFICATION_QUEUE` と両 DLQ | 予約後の同期・通知と失敗処理 | 実予約前に自分の4 queue と consumer を確認 |
| `LINE_RATE_LIMITER` / Durable Object | LINE 通知の送信速度制御 | コードでは任意。使う場合は既存クラスと migration の binding を保持 |
| `CACHE` / KV | 公開カタログの cache | コードでは任意。テンプレートのゼロ ID は実 ID に変更 |
| `STORAGE` / R2 | `CSV_ARCHIVE_ENABLED=true` 時の CSV 保管 | 任意。使う場合のみ自分の bucket と保管方針を用意 |
| `METRICS` / Analytics Engine | 計測 | コードでは任意。使う場合は自分の dataset |
| `RESERVATION_WORKFLOW` | `WORKFLOW_ENABLED=true` 時の予約確認 | 任意。binding を残す場合はクラス・名前を一致させる |
| `EMAIL` / Email Service | owner 宛通知 | コードでは任意。実予約前は送信元ドメインと許可・確認済み宛先を検証 |
| `CF_VERSION_METADATA`、crons | 版情報、期限処理・同期等の定期処理 | 配備設定と実際の実行状態を確認 |

コード上で任意の binding も、この Wrangler テンプレートでは宣言されています。宣言を残すなら自分のリソースを用意し、使わずに外す場合は配備前の dry-run と該当機能の確認をしてください。

公開先では `wrangler.jsonc` の `vars.ENVIRONMENT` を `production` に変更してください。`local` は開発用の管理画面表示を含むため、外部公開には使いません。まず `npm run cf:check` で設定と bundle を確認し、公開する commit と対応するソースを揃えます。

公開予約と管理画面に使うホストを決め、両方を自分の Worker にルーティングします。管理ホストは [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) の self-hosted application で保護し、公開ホスト全体はその保護対象に含めません。`instance-config.json` の `adminHostname`、表示名、`operationsEmailSender`、`staffEmailDomain` を自分の値に合わせます。`kyoto` は地名表示ではなく互換性用の技術 ID です。この1店舗手順ではその ID と `mensMenuStoreId` / `stagingStoreIds` の整合を保ち、店舗の表示名を変更してください。

Access の team domain と application AUD を `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` に設定し、`Cf-Access-Jwt-Assertion` を実アプリが検証できることを確認します。[JWT 検証の公式説明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)も参照してください。

リモート DB は新規・空であることを確認し、全 migration の後で初期データを適用します。`seeds/bootstrap.sql` を gitignored の `.wrangler/bootstrap.sql` にコピーし、`owner@example.invalid` を本人の **Access で検証されるメールアドレス**に変更します。店舗・メニュー・営業時間を自分の値に見直し、対象店舗の Calendar ID も実 Calendar を接続する段階で設定します。メールなど SQL 文字列に単一引用符が含まれる場合は、SQL の規則どおり二重化します。SQL 内に Secret を書きません。自分の新規 DB と binding を再確認した後だけ、次を実行します。

```sh
set -eu
./node_modules/.bin/wrangler d1 migrations apply DB --remote
./node_modules/.bin/wrangler d1 execute DB --remote --file .wrangler/bootstrap.sql
```

初期データは初回の Worker 配備より前に適用してください。すでに確認用の配備へアクセスした場合は、KV に空のカタログが残ることがあります。既存のカタログ cache は有効期限が60秒なので、期限後に公開 options を再取得し、1店舗になったことを確認します。

初回ログインでは一致するメールの `pending:` 行だけが検証済み Access subject に結び付きます。別メール、別 subject、無効化済み owner が拒否されることを確認します。ローカルの開発用 owner 表示で代用しません。

LINE Login channel とその LIFF app、Messaging API channel と公式アカウントを自分の Provider 内に設定します。`LINE_CHANNEL_ID`、`LINE_LIFF_ID`、`LINE_CHANNEL_SECRET`、`LINE_OFFICIAL_ACCOUNT_ID`、`LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` は別の値です。Login 側と公式アカウントの連携、`profile` scope と友だち状態、公開ホストの LIFF URL、`/api/line/webhook` の署名検証を実接続で確認します。[LIFF の設定](https://developers.line.biz/en/docs/liff/developing-liff-apps/)と[Messaging webhook](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)を参照してください。

`LINE_CHANNEL_ID` は Login 側の ID、`LINE_CHANNEL_SECRET` は webhook 署名検証に使う Messaging API 側の channel secret です。非秘密値は `wrangler.jsonc` の `vars`、秘密値は自分の Worker の secrets に設定します。`.dev.vars` の値はリモートへ自動反映されません。

Google Calendar API を自分の project で使い、対象店舗の Calendar ID、service account email / private key、予定の読み書きに必要な Calendar 共有権限を設定します。`GOOGLE_CALENDAR_WEBHOOK_URL` は実公開ホストの `/api/google/calendar/webhook` に合わせます。Google import と live availability は Calendar 共有、service account のアクセス、watch/webhook、競合・同期処理を実接続で確認するまで false のままにします。確認後は `GOOGLE_IMPORT_ENABLED=true` と `GOOGLE_LIVE_AVAILABILITY_ENABLED=true` に設定し、空き枠と同期を再確認してください。[Calendar 共有権限](https://developers.google.com/workspace/calendar/api/concepts/sharing)と[push 通知](https://developers.google.com/workspace/calendar/api/guides/push)を確認してください。

初期データの Calendar ID は NULL です。次の SQL を gitignored の `.wrangler/calendar.sql` に保存し、例の値を Calendar の設定画面で確認した実 ID に置き換えてください。ID が未設定のまま Google のフラグを有効にすると、空き枠・予約の検証が失敗します。

```sql
UPDATE stores SET google_calendar_id = 'calendar-id@example.invalid' WHERE id = 'kyoto';
```

```sh
set -eu
./node_modules/.bin/wrangler d1 execute DB --remote --file .wrangler/calendar.sql
./node_modules/.bin/wrangler d1 execute DB --remote --command "SELECT id, google_calendar_id FROM stores WHERE id = 'kyoto'"
```

Turnstile widget を予約ホスト名に登録し、site key と Worker secret の `TURNSTILE_SECRET_KEY` を別々に設定します。`TURNSTILE_EXPECTED_HOSTNAME` と `TURNSTILE_EXPECTED_ACTION` は実際の hostname / `reservation-submit` と揃え、サーバーの Siteverify 成功・拒否・hostname/action 不一致を確認します。[Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)が公開前の確認対象です。[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)を使い、秘密値を git や公開ログへ置かないでください。

owner の承認待ち通知を受け取れるよう、`OPERATIONS_NOTIFICATION_EMAIL` または `PENDING_APPROVAL_OWNER_EMAIL` と `EMAIL` binding を設定します。送信元は `instance-config.json` の `operationsEmailSender` で、[Email Service の送信元ドメイン](https://developers.cloudflare.com/email-service/get-started/send-emails/)として使えることを確認します。受信先は自分のアカウントで許可・確認し、実際の到達を確認してください。Web Push は VAPID 鍵と連絡先を設定した場合の補助です。通知を受け取れないまま承認待ち予約を受け付けないでください。

## 3. 実予約前の確認

自分の設定・Secret・初期データ・公開文書を揃えてから、確認用の公開先へ配備します。Google の2フラグは初回配備時に明示的に false とし、実 Calendar の ID・共有・接続確認後に true にして再配備します。

```sh
set -eu
npm run admin:build
npm run cf:check
npm run deploy
```

この配備は導入作業者自身が行うものです。以下の実接続チェックが終わるまで実予約を案内しません。

- `public/legal/` のプライバシー、規約、通知、取消、事業者・料金・連絡先を実態に合わせ、関連する `RESERVATION_*_VERSION` も更新する。
- 配備した版と対応する AGPL ソースが公開され、`public/source.html` の URL がその版を指すことを確かめる。
- 自分の公開ホストで1店舗のメニュー・空き枠を表示し、管理ホストで Access 認証後に owner の `/api/admin/me` を確認する。未登録・無効化 owner と公開ホストからの管理アクセスも拒否されることを確かめる。
- 架空のテスト利用者で LINE 本人・友だち判定、Turnstile、予約申込から承認・通知・Google 反映まで確認する。予定や通知の失敗、再試行、取消時の扱いと、ログに個人情報・Secret が出ないことも確認する。
- 保存期間、データの出力・復旧・削除、ドメイン・secret・binding の更新手順を自分の運用で決める。

ローカルの `health`・公開 options は **模型の証拠**、自動テストは **fixture の証拠**です。Access、LINE、Google、Turnstile、Email の接続と実予約の成否は、自分のアカウントでの実測だけで判断してください。旧 [Salon Reservation OSS](https://github.com/ojungo69/salon-reservation-oss) は別の実装として残り、その導入の順序だけを参考にしています。

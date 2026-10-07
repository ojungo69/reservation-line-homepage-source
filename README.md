# Reservation system source

Cloudflare Workers/Hono/D1、LINE/Google Calendar と React 管理画面で構成する予約システムです。現在の稼働実装から、実データと本番運用を分離した公開用ソース候補です。

## Local setup

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix admin-app
cp .env.example .dev.vars
npm run cf:types
npm run d1:migrations:apply
npm run d1:seed
npm run admin:build
npm run dev
```

`instance-config.json` は架空の表示名・管理ホスト・送信元・スタッフメールのドメイン・店舗ポリシーです。`staffEmailDomain` は店舗ログインメールの初期値に使い、送信元のサブドメインとは独立して設定します。資格情報はこのファイルに書かず、ローカルでは gitignored の `.dev.vars`、配備時は自身の Wrangler secrets で設定してください。実際のWeb予約には自身の Cloudflare Access、LINE、Google、Turnstile 設定が必要です。未設定の認証を迂回するデモ機能はありません。

店舗/メニューは架空のサンプルです。旧プロトコルの技術IDと時間・価格の検証ケースは互換性のため保持しています。`public/legal/` は記入欄を含む例です。実予約を受け付ける前に、自身の事業者情報・規約・処理国・価格/連絡先へ置き換えてください。

## Verification

```sh
npm run typecheck
npm run knip
npm test
npm run admin:typecheck
npm run admin:test
npm run admin:build
npm run cf:check
npm run audit:root
npm run audit:admin
```

公開側にはアプリのテストを収録しています。本番配備・バックアップ・復旧・監視と、それらの運用契約テストは運用側の非公開リポジトリで維持します。公開側へ常設の本番 runner や本番 Secret を接続しないでください。

## License and source

Original software copyright 2026 ojungo69. GNU Affero General Public License version 3 only. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Names, operator content and instance data are examples; third-party dependencies retain their own notices.

Corresponding source: https://github.com/ojungo69/reservation-line-homepage-source

Local secret configuration follows [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

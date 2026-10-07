# Reservation system source

Cloudflare Workers / Hono / D1、LINE、Google Calendar、React 管理画面で動く予約システムの公開ソースです。このリポジトリを今後の OSS 開発の正本とします。架空の1店舗から始められますが、実予約には各運営者の Cloudflare・LINE・Google アカウントと公開文書が必要です。

[導入手順](docs/INSTALL.md)は、独立した Cloudflare リソースを用意し、ローカルで1店舗を確かめてから、外部認証・通知・法定表示を確認する順序です。以前の [Salon Reservation OSS](https://github.com/ojungo69/salon-reservation-oss) の導入手順を参考にしています。旧版は Durable Objects と owner token を使う別実装であり、このアプリの導入ファイルや認証方式とは互換ではありません。

## ローカルで最初に確認する

Node.js 24 を使い、[導入手順のローカル手順](docs/INSTALL.md#1-架空の1店舗をローカルで確認する)に従って、すべての D1 migration と `seeds/bootstrap.sql` を新しいローカル DB に適用してください。既存の `seeds/dev.sql` は4店舗の開発用 fixture です。ローカルの画面や API が動いても、Cloudflare Access、LINE、Google、Turnstile、通知の実接続は証明されません。

## 開発時の確認

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix admin-app
npm run cf:types
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

公開側にはアプリのテストを収録しています。本番配備・バックアップ・復旧・監視と、それらの運用契約テストは非公開の運用側で維持します。公開リポジトリに本番 Secret や常設の本番 runner を接続しないでください。

## 導入後の保守と報告

自分の環境の更新・バックアップ・復旧は[運用手順](docs/OPERATIONS.md)を参照してください。検証した版は [Releases](https://github.com/ojungo69/reservation-line-homepage-source/releases) に記録します。初回は導入検証用の prerelease とし、第三者の新規アカウントでの Access・LINE・Google・Turnstile・Email の通し確認は未実施です。

通常の不具合・改善提案は [Issue](https://github.com/ojungo69/reservation-line-homepage-source/issues/new/choose)、機密性のある脆弱性は[非公開報告窓口](SECURITY.md)を使ってください。外部コード PR の受け入れ条件は [CONTRIBUTING.md](CONTRIBUTING.md) に記載しています。

## ライセンスと対応するソース

Original software copyright 2026 ojungo69. GNU Affero General Public License version 3 only. [LICENSE](LICENSE) と [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。対応する公開ソースは https://github.com/ojungo69/reservation-line-homepage-source です。自分の改変版を配備する場合は、配備版に対応するソースを公開し、[公開ソースへのリンク](public/source.html)もその版に合わせて確認してください。

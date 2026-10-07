# 導入後の更新・バックアップ・復旧

対象は、[INSTALL](INSTALL.md)で運営者自身が導入した環境です。新規導入用の `seeds/bootstrap.sql` や4店舗用の `seeds/dev.sql` を既存 DB に再適用しません。公開リポジトリには個別事業者の運用 workflow、設定、Secret は含みません。

## 更新前に記録する

現在の commit/tag、Worker version ID、DB の migration 履歴とバックアップ、バインディング、設定変更点を記録します。新しい版は別の checkout で準備し、変更点・既知の制限・DB 互換性を確認します。自分の `wrangler.jsonc`、`instance-config.json`、公開文書、Secret を公開側のサンプルで上書きしないでください。

## 公開版の検証と運営者設定を分ける

最初に、対象版の未変更の公開 checkout で [README の開発時の確認](../README.md#開発時の確認)をすべて通します。`publication-config.test.ts` は `ENVIRONMENT=local`、サンプルの DB/KV ID、公開用設定を検証します。実運用の設定を入れた checkout では、この検証は失敗します。

次に、別の更新用 checkout または自分の fork で、その版に運営者の設定・公開文書を照合して反映します。Secret は git に置きません。`npm ci --ignore-scripts` と `npm ci --ignore-scripts --prefix admin-app` を実行し、反映後の型検査・管理画面 build・Worker dry-run を確認します。

```sh
set -eu
npm run cf:types
npm run typecheck
npm run admin:typecheck
npm run admin:build
npm run cf:check
```

公開用テストを通すために運営者の DB ID や設定をサンプルへ戻したり、テストを弱めたりしません。公開版そのものの検証と、自分の配備設定・確認環境での検証は別々に必要です。

`wrangler whoami`、`wrangler d1 info DB`、自分の設定の Worker 名・DB ID を照合し、対象アカウントと DB を確認します。複数環境を使う場合は config/env 指定をすべてのコマンドで統一します。以下は INSTALL と同じ default config の例です。

予約を受け付けない時間帯を決め、HTTP 以外の scheduled、Queue/DLQ、Workflow、外部 webhook、別ツールからの書き込みも確認します。`MAINTENANCE_MODE=d1-dr-freeze` は配備されて初めて入口で働きます。設定ファイルの編集だけでは停止しません。新しい HTTP は503、scheduled は処理せず、Queue は再試行等の挙動になります。すでに実行中の処理や古い Worker/Workflow、すべての Queue 消費を止めた証拠にはなりません。書き込み元の停止・処理終了を確認してから migration や復旧に進みます。

このフラグで停止する場合は、**更新前の現行コード**と自分の現行設定を用意した checkout で `MAINTENANCE_MODE=d1-dr-freeze` を設定し、build/dry-run 後に `npm run deploy` で停止を配備します。自分のホストの `/.well-known/sdj-d1-dr-freeze` が503、`reason: d1-dr-freeze`、`sentinel: true` を返すことを確認します。これは後述の新版配備とは別の操作で、**DB のバックアップ・migration より前**に完了させます。停止が確認できない場合は DB 操作へ進みません。

## D1 をバックアップする

[D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) は schema と data を SQL に保存します。export 中は他の DB 要求がブロックされるため、低負荷帯に実施し、完了とサービスへの影響を確認します。次は自分のリモート DB を読み出す例です。

```sh
set -eu
umask 077
oss_backup_dir=".wrangler/backups/pre-update-$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$oss_backup_dir"
mkdir -p "$oss_backup_dir"
./node_modules/.bin/wrangler whoami
./node_modules/.bin/wrangler d1 info DB
./node_modules/.bin/wrangler d1 time-travel info DB --json > "$oss_backup_dir/time-travel.json"
./node_modules/.bin/wrangler d1 export DB --remote --output "$oss_backup_dir/database.sql"
test -s "$oss_backup_dir/database.sql"
sha256sum "$oss_backup_dir/database.sql" > "$oss_backup_dir/database.sql.sha256"
```

SQL は顧客情報・認証に関わる保存データを含み得ます。`.wrangler/` は gitignored ですが、暗号化ではありません。権限を制限し、運営者の暗号化された別保管先にも保存して、保持期限と削除方法を決めてください。SQL・bookmark・実行ログを公開 Issue や release asset に添付しません。

上の SHA-256 計算には `sha256sum` が必要です。macOS などで未導入の場合は、その行を `shasum -a 256 "$oss_backup_dir/database.sql" > "$oss_backup_dir/database.sql.sha256"` に置き換えます。

このバックアップは D1 だけです。R2 のオブジェクト、KV、Durable Objects、Queue/DLQ、Worker の版・Secret、LINE/Google の状態は別に記録・保護します。

## 更新を適用する

上の公開版検証、運営者設定の build/dry-run、確認環境での検証とバックアップを終えてから、[migration](https://developers.cloudflare.com/d1/reference/migrations/) の未適用一覧を確認します。公開側の `npm run d1:migrations:apply` はローカル専用なので、リモート更新には次の明示的なコマンドを使います。旧版への互換性を確認した後に実施してください。

停止に `MAINTENANCE_MODE=d1-dr-freeze` を使っている場合は、更新先の config にもその値を維持します。サンプルの空値のまま `npm run deploy` すると停止が解除されます。新版の配備後も sentinel `/.well-known/sdj-d1-dr-freeze` の503と停止設定を確認し、Queue 等の別の停止手段も維持します。受付再開は確認を終えてから別の操作で行います。

```sh
set -eu
./node_modules/.bin/wrangler d1 migrations list DB --remote
./node_modules/.bin/wrangler d1 migrations apply DB --remote
npm run deploy
```

配備時の config、Secret、binding、公開ソースへのリンクが対象版に対応することを確かめます。メンテナンス中は `/api/health` も503になり得ます。書き込みを再開できる状態にしてから `/api/health`、公開メニュー・空き枠、Access owner 認証、予約・承認・取消、通知、Google 同期、Queue/DLQ の状態を確認します。個別リリースに migration 手順がある場合はそちらを優先します。

## SQL 復元を隔離環境で試す

信頼できるバックアップを、最初に別の空 DB へ復元します。復元先へ migration や bootstrap を先に適用しません。フル export に含まれる schema と migration 履歴を確認し、既存 DB への追記とは区別してください。

次は `.wrangler/backups/restore.sql` に置いたバックアップを、新しいローカル保存先で試す例です。ローカル Worker と外部送信は起動しません。

```sh
set -eu
test -s .wrangler/backups/restore.sql
test ! -e .wrangler/restore-check
./node_modules/.bin/wrangler d1 execute DB --local --persist-to .wrangler/restore-check --file .wrangler/backups/restore.sql
./node_modules/.bin/wrangler d1 execute DB --local --persist-to .wrangler/restore-check --command "PRAGMA foreign_key_check;"
./node_modules/.bin/wrangler d1 migrations list DB --local --persist-to .wrangler/restore-check
```

外部キー検査の結果が空であることに加え、schema・index・trigger・各表の件数と必要な値、migration 履歴を元 DB と比較します。件数だけでは同一性を証明できません。SQL import が外部キー順序などで失敗したら、失敗した復元先を本番へ切り替えず、dump を保全して原因を調べてください。既存データの削除や制約の無効化で強行しません。

Wrangler 4.129.0 の `d1 export --local` は `--persist-to` を受け付けません。INSTALL の `.wrangler/oss-install` とは別の default 保存先を export してしまわないよう注意します。上の復元例は `d1 execute` 側だけに保存先を指定します。実データのローカル複製も運営者の機密データとして管理してください。

実際の復旧で SQL を使う場合も、新しいリモート DB へ取り込み、照合が通った後に運営者の判断で binding を切り替えます。DB だけでなく、復元時点以後の予約、通知・同期 job、Queue、外部 Calendar との食い違いを調整してから受付を再開してください。

## Time Travel とコードの切り戻し

[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) はリモート D1 を過去の状態へ戻します。指定時点以後の更新が失われる操作です。利用可能な期間を自分のプラン・DB で確認し、復旧前の bookmark と SQL を保存します。運営者が対象 DB・復旧時点・失われる更新を承認し、書き込み元を停止した後だけ実施します。具体的な timestamp/bookmark 指定は公式手順で確認してください。

復旧後は migration 履歴・整合性・予約状態を照合し、Cloudflare が返す復旧前の bookmark も保管します。D1 を戻しても、外部サービスで送信済みの通知や Calendar 更新は取り消されません。

[Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) は D1 の復元とは別です。旧版コードが現在の schema・binding・Secret と互換であることを確認して、記録した version ID を選びます。互換性がない場合は受付停止を保ち、前進修正または計画した DB 復旧を選びます。単に旧版を配備しただけで DB や外部状態も戻ったと判断しないでください。

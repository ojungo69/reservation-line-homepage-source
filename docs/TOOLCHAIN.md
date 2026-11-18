# Node と npm

開発・CI の対応版は Node.js `>=24.15.0 <25` と npm `12.2.2` です。両 package.json に同じ engines / devEngines / packageManager を指定しています。root と admin-app の `.npmrc` は `engine-strict=true` のみです。

通常の install / ci は、検証した npm 9.9.4 では EBADENGINE、10.9.4 / 11.19.1 では EBADDEVENGINES で拒否されます。npm 9 の明示的な npm run までは拒否しません。force や設定上書きに対する敵対的利用者防御でもありません。npm 12 は root の承認済み allowScripts を使い、admin-app は明示的な空台帳で依存 install script を拒否します。CI の既存 --ignore-scripts は継続します。

Node 24 を用意した後、global npm を変更せずにこの checkout 用の npm を使う例です。同じ subshell 内で検証・導入コマンドを実行し、終了時に一時領域だけを削除します。

```sh
(
  set -eu
  export RUNNER_TEMP="$(mktemp -d)"
  export GITHUB_OUTPUT="$RUNNER_TEMP/outputs" GITHUB_PATH="$RUNNER_TEMP/paths"
  trap 'node .github/scripts/npm-toolchain.mjs cleanup; rm -f -- "$GITHUB_OUTPUT" "$GITHUB_PATH"; rmdir -- "$RUNNER_TEMP"' EXIT
  node .github/scripts/npm-toolchain.mjs bootstrap
  export TOOLCHAIN_DIRECTORY="$(sed -n 's/^directory=//p' "$GITHUB_OUTPUT")"
  export PATH="$(cat "$GITHUB_PATH"):$PATH"
  node .github/scripts/npm-toolchain.mjs verify
  npm ci --ignore-scripts
  npm ci --ignore-scripts --prefix admin-app
  npm run typecheck
)
```

CI も同じ standalone helper を使います。取得済み npm の lock に記録された exact version、公式 tarball URL と承認済み SHA-512 SRI を照合してから npm を実行し、PATH を公開します。cleanup はジョブ固有ディレクトリと所有記録を検証して実行します。SIGTERM と通常の失敗を試験していますが、runner の強制終了や電源断で cleanup の実行まで保証するものではありません。

この変更で @types/node 26、Wrangler compatibility_date、override や AST alias の判断を解決済みとは扱いません。Linux x64 のローカル検証と ARM64 の実 CI 証拠は別に扱います。

すべての setup-node ステップは `package-manager-cache: false` を指定し、明示的な `cache` 入力も省略します。Node 単独の Sonar / 監視ジョブも対象です。配布版に同梱された npm が helper より前に `npm config get cache` を実行すると、プロジェクトの npm 12.2.2 契約で拒否されるためです。Node バイナリを再利用する runner の tool cache は引き続き使います。

## 依存の監査

`npm run audit:root` と `npm run audit:admin` は `.github/scripts/audit-gate.mjs` を実行します。

- **監査の範囲**: このリポジトリにコミットされた lockfile を、npm の公式レジストリに問い合わせて監査します。dev・optional・peer を含むすべての依存が対象です。どのフォルダから実行しても、また親フォルダの `package.json` がこのリポジトリを workspace に含めていても、このリポジトリの lockfile を監査します。
- **設定に左右されない**: ユーザー設定と環境変数にある npm の設定は使いません（`--userconfig=/dev/null` を指定し、`npm_config_*` と `NODE_ENV` を取り除き、install script を無効にします）。プロジェクトとマシン全体の `.npmrc` は読み込まれますが、結果を変える設定（オフライン、レジストリ、lockfile の扱い、監査する依存の種類）はコマンドの引数で上書きします。npm のキャッシュには毎回新しい空のフォルダを使い、終わったら消します。古いキャッシュは advisory の深刻度を古い値のまま返すためです。
- **失敗する条件**: 例外（下の `ALLOWED_ADVISORIES`）に一致しない high または critical の advisory が 1 件でもあれば失敗します。次の場合も失敗します。
  - npm が監査を完了できなかった場合。npm のエラーの内容を表示します。
  - レポートの形が崩れている場合、件数の集計とレコードが合わない場合、パッケージの深刻度がその advisory と合わない場合。
- **守れない範囲**: 同じジョブで先に動くコード（依存パッケージのコマンド、npm の lifecycle script、ゲート自体の書き換え）からは守れません。これまでの `npm audit` と同じく、コードレビューで防ぎます。

例外を書けるのは、同じファイルの `ALLOWED_ADVISORIES` だけです。

- **項目の中身**: advisory ID、その advisory を持つパッケージ、対象（root と admin-app の一方または両方）、許す最大の深刻度、期限、理由を必ず書きます。
- **承認**: 項目の追加と延長にはオーナーの承認が必要です。
- **自動で失敗する条件**: 期限の当日以降になった項目と、監査に現れなくなった項目は失敗します。修正版が出たら依存を更新し、その項目を削除してください。

現在の例外は GHSA-fc5q-39xc-vjpf（picomatch `<= 4.0.7`、修正版なし）の 1 件だけで、期限は 2026-12-18 です。picomatch はビルドとテストの道具の中でしか動かず、Worker と管理画面の配信物には含まれません。

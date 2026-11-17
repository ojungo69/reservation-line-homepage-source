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

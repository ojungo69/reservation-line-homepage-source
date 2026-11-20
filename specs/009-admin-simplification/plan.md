# Implementation Plan: 管理画面の整理（使わない欄と表示を減らす）

**Branch**: `009-admin-simplification` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-admin-simplification/spec.md`

## Summary

店舗ごとに稼働中の予約枠が 1 つしかない運用に合わせて、管理画面を整理する。

- 選ぶ必要のない欄は、画面が自動で値を決めて隠す: リソース、選べる店舗が 1 つのときの店舗、予約経路の初期値。
- 使われていない表示を除く: 来店履歴、来店中の絞り込み、重複したアレルギーの行、LINE 友だちの切り替え、CSV 出力のボタン。
- 分かりにくい名前を直す: 開始時刻・長さの変更、Google 連携の競合の店舗名。

サーバーの API・検査・データ・通知・権限は変えない。画面が決めた値を、今と同じ形で送る。止まっている CSV の控えの保管は、コードだけを取り除く（配備の設定ファイルは変えない）。

## Technical Context

- **Language/Version**: TypeScript。Worker（`src/`）は Hono on Cloudflare Workers + D1。管理画面（`admin-app/src/`）は React + Vite + TanStack Query。Node `>=24.15.0 <25`、npm `12.2.2`（`devEngines` で固定）。
- **Primary Dependencies**: 既存のものだけ。新しい依存は足さない。
- **Storage**: D1 のスキーマ・データは変えない。CSV の控えを書くコードを消すだけで、保管場所の設定は変えない。
- **Testing**: vitest。ルートは `npm run test:unit`（node）と `npm run test:worker`（Workers の pool）。管理画面は `admin-app` の vitest（jsdom + Testing Library）。完了のゲートは CI と同じ一式（下の「検証」）。
- **Target Platform**: Cloudflare Workers。端末は iPad・iPhone の Safari と Mac のブラウザ。
- **Project Type**: Web（Worker の API と、管理画面の SPA と、お客様向けの予約ページ）。
- **Performance Goals**: 変えない。新しい通信は足さず、どの画面もすでに読み込んでいる店舗・リソースの設定から判断する。
- **Constraints**:
  - サーバーが受け付ける値と検査を変えない（FR-024）。
  - 配備と検査の設定ファイルは変えない。対象は `wrangler.jsonc`、CI のワークフロー、`tsconfig*.json`、`vitest*.config.ts`、`admin-app/vite.config.ts`、`admin-app/vitest.setup.ts`、`knip.jsonc`、`sonar-project.properties`、`.npmrc`、`.gitignore`。変えるときは、ほかの変更と分けて行う。
  - SonarCloud の関数ごとの認知的複雑度は 15 以下に保つ。作成パネルのような長い部品に分岐を足すときは、判断を純関数に出す。
  - 今の予定表と新しい予定表（spec 008 の切り替え）の両方で同じ結果になる（FR-026）。作成パネルと詳細パネルは両方の予定表から同じ部品で開かれるので、部品の中で判断する。
- **Scale/Scope**: 管理画面の約 25 ファイルとその試験、サーバーの 4 ファイル、文書の数か所。

## Constitution Check

`.specify/memory/constitution.md` はひな形のままで、原則が書かれていない。代わりに、このリポジトリの既存の決まりで確かめる。

| 確かめること | 結果 |
| --- | --- |
| 新しい依存を足さない | 足さない。既存のフックと部品を使う |
| 試験を先に書き、正しい理由で赤くしてから実装する | 各タスクで、公開の境界（画面に出る欄と、サーバーに送る内容）で試験を先に書く |
| コメントは次に読む人のために、コードで分からない理由だけを書く | 古くなったコメント（リソースの削除の説明）は事実に合わせて直す |
| サーバーの検査と権限を変えない | 変えない。LINE 友だちの紐付けの店舗も、今と同じ形で送る |
| 配備・検査の設定を変えない | 変えない（FR-023 をコードの撤去に絞った） |

違反は無い。設計の後にもう一度確かめた（[research.md](./research.md) の決定 1〜10 を反映した後も同じ）。

## 設計の要点

詳しい理由と比べた案は [research.md](./research.md) にある。画面ごとの出し分けの約束は [contracts/ui-fields.md](./contracts/ui-fields.md) にある。

1. **リソースの判断は 1 つの純関数にまとめる**（決定 1・2）。
   - 置き場所は `admin-app/src/lib/store-resources.ts` の `resolveStoreResources(resources, storeId, selectedId)`。
   - 店舗の稼働中の枠を数え、4 つの場合に分けて返す: `unknown`（設定が未取得・取得失敗・店舗が未決定）、`none`、`single`、`multiple`。送るべき `resourceId` も一緒に返す。
   - 使うのは作成パネル・ブロック作成・繰り返しブロック・予約の詳細の 4 か所。
   - 「読み込み済み」は、取得したデータがそろっているかで決める。読み込み中の印（`isPending`）は使わない。取得の失敗を「枠が 0 件」と取り違えないため。
2. **自動で決めた値は state に書き戻さない**（決定 2）。
   - 描画のたびに、利用者が選んだ値と設定から有効な値を導き、検査・送信・確認の画面に使う。変更の有無の判定は、利用者が選んだ値で行う。
   - これで、店舗の切り替えや設定の遅れて届く読み込みで、古い値が残る隙が無くなる。
3. **店舗の欄**は、設定の店舗が 1 件のときだけ隠す（決定 3）。店舗スタッフに返る設定は自分の店舗だけなので、役割を見る必要は無い。
4. **予約経路の初期値**は `walk_in`（表示名「店頭」）を定数にして、初期値・リセット・変更の有無の判定の 3 か所で使う。表示名と並びは変えない（決定 4）。
5. **予約の詳細のリソース名**は、店舗の枠が 1 つで、予約がその枠に入っているときだけ隠す（決定 5）。設定の読み込み中は隠し、取得に失敗したら今どおり出す。運用中の店舗はどれも枠が 1 つなので、出てから消えるちらつきを避けられる。
6. **名前の変更**は画面の文字（ボタン・画面の題名・送信ボタン・完了の通知）と文書だけを変える。API のパスとエラーの符号は変えない（決定 6）。
7. **LINE 友だちの紐付けの店舗**は、画面の上で選んでいる店舗（全店舗のときは設定の先頭の店舗）を自動で送る。サーバーの検査は変えない（決定 7）。
   - この店舗は、操作の記録の詳しい情報に残るだけで、紐付く相手は変えない。
   - サーバーには、その意味を書いた 1 行のコメントを足す。
8. **予約管理の店舗の列**は、表示している店舗が 1 つに決まっているときだけ隠す（決定 8）。
   - 「来店中」は絞り込みの選択肢から外す。
   - 保存された絞り込みに来店中の値が残っていたら、既定に戻す。
9. **CSV の控え**は、控えを書く部品とその試験、呼び出し、型だけを消す（決定 9）。CSV 出力の応答（中身・ヘッダー・ファイル名）は変えない。
10. **0 件の案内の文**は、手動予約では店舗スタッフも読むので、設定の画面へ誘う文を入れない。ブロックと繰り返しブロックはオーナーだけが使うので、設定の「リソース」タブを案内してよい（決定 10）。

## Project Structure

### Documentation (this feature)

```text
specs/009-admin-simplification/
├── spec.md
├── plan.md              # この計画
├── research.md          # 決定と理由
├── data-model.md        # 画面で導く値（保存するデータは変えない）
├── quickstart.md        # 確かめ方
├── contracts/
│   └── ui-fields.md     # 画面ごとの出し分けの約束
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks が作る
```

### Source Code (repository root)

```text
admin-app/src/
├── lib/
│   ├── store-resources.ts           # 新規: リソースの判断（純関数）
│   ├── link-store-id.ts             # 新規: 紐付けで送る店舗（純関数）
│   ├── reservation-origin.ts        # 初期値の定数
│   ├── reservation-search-state.ts  # 来店中を外す・保存値の検査
│   └── google-sync-view-model.ts    # 競合の店舗名
├── hooks/
│   ├── use-resources.ts             # 読み込み済みの印、使われなくなる削除のフック
│   ├── use-reservations.ts          # 完了の通知の文
│   └── use-reservation-search.ts    # CSV の URL を作る関数を消す
├── components/schedule/
│   ├── reservation-create-panel.tsx
│   ├── external-block-create-dialog.tsx
│   ├── reservation-detail-panel.tsx
│   ├── reservation-reschedule-dialog.tsx
│   ├── reservation-duration-dialog.tsx
│   └── reservation-list-card.tsx
├── components/settings/
│   ├── recurring-blocks-tab.tsx
│   ├── closures-tab.tsx
│   └── resources-tab.tsx
├── components/customers/
│   ├── customer-detail-panel.tsx
│   └── link-line-from-card-dialog.tsx
└── pages/
    ├── reservations.tsx
    ├── line-friends.tsx
    ├── google-sync.tsx
    └── settings.tsx                 # 古いコメントの修正だけ

src/
├── routes/admin-api.ts              # CSV の控えの呼び出しを消す
├── bindings.ts                      # 使われなくなる型を消す
├── storage/r2-helpers.ts            # 削除
└── admin/
    ├── line-friends.ts              # 記録の店舗の意味のコメント
    ├── settings-common.ts           # 古いコメントの修正
    └── settings-resources.ts        # 古いコメントの修正

test/r2-helpers.test.ts              # 削除
docs/admin-authz-matrix.md           # リソースの削除の説明を実態に合わせる
specs/008-admin-calendar-ux/*.md     # 操作の名前を新しい名前に
```

**Structure Decision**: 既存の Web 構成（`src/` と `admin-app/src/`）のまま。新しいファイルは純関数 2 つとその試験だけ。

## 進め方

1. **土台**: 共有の純関数 `store-resources.ts` を試験と一緒に先に入れる。名前・場合分け・「読み込み済み」の定義をここで決め、後の作業はこれを使う。
2. **画面ごとの作業**: 互いに別のファイルを触る 5 つのまとまりに分けて進める。同時に進めるときは、まとまりごとに別の作業ツリーを使う。
   - 作成パネルと予約経路（US1）
   - ブロック・繰り返しブロック・休業日・リソース一覧（US3・FR-015）
   - 予約の詳細と変更の画面、名前の変更（US2）
   - 予約管理と LINE 友だち（US4・FR-011 の一覧のカード）
   - 顧客カルテ・Google 連携・CSV の控え（FR-011 のカルテ・US5）
3. **プルリクエスト**: 触るファイルが重ならない 2 つに分ける。どちらを先にマージしてもよい。
   - A: 土台 + US1 + US2 + US3 + FR-015 + この spec の文書
   - B: US4 + US5（FR-015 を除く）+ FR-011 の一覧のカードとカルテ
4. **確認と本番**: 確認用環境でオーナーが受け入れの場面を見てから、本番に出す。運用側の手順は、この公開リポジトリには書かない。
5. **後片付け**: 操作の名前の変更に合わせて、スタッフ向けの説明資料を運用側で直す。

## 検証

- 試験は各タスクで先に書き、正しい理由で赤くなるのを見てから実装する。重さを確かめる場所は、画面に出る欄と、サーバーに送る内容。
- FR-025（店舗スタッフに顧客メモとアレルギー・注意事項を見せる）の回帰の試験は、予約の詳細を触る前に足す。
- 完了のゲートは CI と同じ一式を手元で通す。
  - `npm run cf:types`、`npm run typecheck`、`npm run knip`
  - `npm run test:unit -- --coverage`、`npm run test:worker`、`node --test .github/scripts/*.test.mjs`
  - `npm run admin:typecheck`、`npm run admin:build`、`npm run coverage:admin`
  - `npm run cf:check`、`npm run audit:root`、`npm run audit:admin`
- 画面の確かめ方は [quickstart.md](./quickstart.md) にある。手元の確認では、今の予定表と新しい予定表の両方を使う。

## Complexity Tracking

違反は無いので空。

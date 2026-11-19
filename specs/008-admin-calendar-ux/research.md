# 調査記録

調査日: 2026-11-17。コード基点: `3f65c69e64fd3999e415c83c14f5c6dfa928c13d`。

## 確認方法と限界

GitHubアプリで共有ソース、関連する既存設計、Issue・PRを読み、Google、Apple、MDN、W3Cの一次資料を確認した。利用者のGoogleカレンダーへログインして操作を検証したわけではない。スマホ・Macの実機試験も未実施である。

Googleの確認済み挙動、現行アプリの実装、今回の提案、実機検証項目を分けて記録する。生成画像はオーナーとの視覚検討用であり、予約データや実装状況の証拠には使わない。

## 1. 文書の置き先

共有アプリの正本は[このリポジトリのREADME](../../README.md)に従う。ルートにDESIGN.mdはなく、既存のspecsは001〜004であったため、初版（PR #45）は005として追加した。その後005〜007が別の機能で使われたため、2026-11-19に008として取り込んだ。

既存の[004-system-improvement](../004-system-improvement/spec.md)は全体の品質改善であり、今回のデザイン・入力仕様は別の実装単位にする。文書PRをマージしても、後続の実装Issueを閉じない。

## 2. 公式資料から確認できた操作

| 確認できたこと | 根拠 | 今回の採用内容 |
|---|---|---|
| モバイルで月名から日付選択を開き、左右にスワイプして月を変える | [Google iOS](https://support.google.com/calendar/answer/6110849?hl=en&co=GENIE.Platform%3DiOS)、[Google Android](https://support.google.com/calendar/answer/6110849?hl=en&co=GENIE.Platform%3DAndroid) | 日付選択と月移動の参考にする |
| 空き時間枠のタップで作成し、既存予定をドラッグで別日時へ移動できる | [Google iOSの作成・編集](https://support.google.com/calendar/answer/72143?hl=en&co=GENIE.Platform%3DiOS)、[Android](https://support.google.com/calendar/answer/72143?hl=en&co=GENIE.Platform%3DAndroid) | 空き枠作成と直接移動の操作目標にする |
| Web版に前後、今日、ミニカレンダー、日・週・月などの表示切替がある | [Google Web表示](https://support.google.com/calendar/answer/6110849?hl=en&co=GENIE.Platform%3DDesktop) | 基本操作とジェスチャーの代替として残す |
| 有効化すると今日、表示切替、新規作成などのキー操作を使える | [Googleショートカット](https://support.google.com/calendar/answer/37034?hl=en&co=GENIE.Platform%3DDesktop) | 入力欄と競合しないキー設計の参考にする |
| Macには2本指スクロールとページ間スワイプがあり、設定を変更できる | [Apple Multi-Touch](https://support.apple.com/en-us/102482) | OSの履歴移動やナチュラルスクロールと競合しない実機試験を行う |

質感の参考は[Googleが2024年に公開したWeb版ライトテーマの画面例](https://workspaceupdates.googleblog.com/2024/10/new-look-and-feel-and-dark-mode-google-calendar.html)である。現在の全アカウントの画面がこの画像と完全一致するとは扱わない。

Googleカレンダーの通常の週グリッドについて、1本指横スワイプの移動量、長押し開始時間、リサイズの細部を公式資料だけで確定できなかった。MacのWeb版で横スワイプが日付切替になるという仕様も未確認である。本アプリの横移動や閾値はオーナー要望に基づく独自の提案として定義する。VoiceOverやTalkBackの専用ジェスチャーを、通常の指操作の根拠にしない。

## 3. Web入力の制約

| 制約 | 根拠 | 設計上の判断 |
|---|---|---|
| `touch-action`は操作開始時に判定され、途中変更はその操作に効かない | [MDN touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action) | 長押し後のCSS切替だけで同じ指のドラッグを実装しない。専用ハンドルを初期の安定経路にする |
| ブラウザがパン・ズームを扱うと`pointercancel`が起きる | [MDN Pointer events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events) | キャンセルで保存せず、仮表示と捕捉を解除する |
| wheelは複数イベントになり、ズーム由来やキャンセル不可の場合もある | [MDN wheel](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event) | 1操作を束ね、慣性を連続した期間移動にしない。`ctrlKey`付き入力を日送りに使わない |
| overscroll制御はスクロールコンテナーに適用される | [MDN overscroll-behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overscroll-behavior) | OSのすべての端操作を止められるとは約束せず、適用領域とブラウザを検証する |
| ドラッグ機能には単一ポインターの代替操作が必要 | [W3C WCAG 2.2 2.5.7](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) | キーボードだけでなく、前後ボタンと日時フォームを残す |

上記はWebプラットフォームの資料である。特定のカレンダーライブラリはまだ選んでいない。実装で候補を選定する場合はContext7と公式資料から現行API・ライセンス・対応環境を確認する。

## 4. 現行コードと差分

| 項目 | 基点commitの実装 | 追加が必要な内容 |
|---|---|---|
| 日表示 | 15分の表示グリッド、リソース列、現在時刻、営業開始への移動、24時間閲覧 | 共通の新しい見た目と入力状態 |
| 週表示 | 7日ごとの予約ボタンを縦積み。日曜始まり | 共通時刻軸、時間比例の位置・高さ、重なり処理 |
| スマホ | 640px未満は日表示固定、予定一覧が初期、時間軸へ切替可能 | 横日送り、選択保存、詳細シート、月表示 |
| 入力 | 空き枠・予約のクリック、セルの矢印キー操作 | pointer状態、横wheel、移動・リサイズ・範囲選択 |
| 更新 | 30秒ポーリングと画面復帰時再取得 | 古い表示を前提にした条件付き保存 |
| API | 同じ店舗・リソースの開始・施術時間変更、冪等性、DB batch | previewとクライアントが見たversionを条件にするcommit |
| 空き候補 | 15分刻み、rescheduleでは保存済みの長さを使用 | 5分単位と変更後の長さを対象にした検証 |
| 通知・同期 | 条件付きLINEジョブ、Google upsertジョブ | 保存成功と外部反映を分けたUI、取消時の再通知説明 |

監査に使用した主なファイルは次のとおり。リンクは基点commitに固定する。

- [schedule.tsx](https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/admin-app/src/pages/schedule.tsx)
- [timeline-grid.tsx](https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/admin-app/src/components/schedule/timeline-grid.tsx)
- [timeline-column.tsx](https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/admin-app/src/components/schedule/timeline-column.tsx)
- [reservation-reschedule.ts](https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/admin/reservation-reschedule.ts)
- [admin-api.ts](https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/routes/admin-api.ts)
- [operations.ts](https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/admin/operations.ts)
- [transitions.ts](https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/src/reservations/transitions.ts)
- [reschedule-idempotency.ts](https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/admin-app/src/lib/reschedule-idempotency.ts)
- [共有デザイントークン](https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/public/glass-tokens.css)
- [管理画面の依存](https://github.com/ojungo69/reservation-line-homepage-source/blob/3f65c69e64fd3999e415c83c14f5c6dfa928c13d/admin-app/package.json)

詳細の権限、清掃、旧予約、通知、versionと冪等性は[予約変更契約](contracts/reservation-interactions.md)に集約する。ここで別の業務定義を作らない。

## 5. 文書から実装へ進む際の未検証事項

- iPhone Safari、Android Chrome、Mac Safari・Chromeの実入力、PWAモード、慣性、ブラウザ履歴との競合。
- ハンドル操作の指への追従と、同じ指の長押しドラッグを追加できるか。
- 実際のGoogleカレンダーで利用者が設定している予定色。今回、利用者のアカウントの色設定は取得していない。
- 予定が密集した週の描画性能、低速通信、低性能端末、ズーム・読み上げ・ダーク表示の実機結果。
- 旧API consumerの範囲と、新しいversion付き契約への切替方法。

これらは実装タスクと公開前の検証項目であり、文書作成を止めるユーザー判断事項ではない。Googleのすべての細部と同一であるとの保証は行わない。

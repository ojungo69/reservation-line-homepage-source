# Security policy

## 非公開の報告先

認証・認可、情報漏えい、入力検証、予約の不正操作などの疑いは [GitHub の非公開脆弱性報告](https://github.com/ojungo69/reservation-line-homepage-source/security/advisories/new)へ送ってください。公開 Issue/PR に脆弱性の詳細や実データを載せないでください。通常の不具合は公開 Issue を使えます。

報告には対象 commit/tag、影響する機能、期待する制限と実際の挙動、架空データによる最小の再現手順を記載します。資格情報、Access/LINE の token、顧客・スタッフ・予約の実データ、DB dump は非公開報告にも添付しないでください。再現は自分が管理する検証環境で行ってください。

## 対応範囲

公開ソースの default branch と最新 prerelease を調査の基点にします。古い版では最新の修正を確認してください。第三者の配備先の認証情報・設定変更や個別運用の復旧は、その運営者へ連絡してください。受付・修正の期限や稼働保証は設けていません。

認証・認可・入力境界・通知/同期の冪等性を変更するときは、既存の関連テストとセキュリティレビューを維持します。Source publication does not grant access to any operator's deployment.

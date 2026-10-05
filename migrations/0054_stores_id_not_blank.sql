-- 空文字の店舗 ID を DB 境界で拒否する。
--
-- スタッフの店舗スコープは admin_users → staff_members → stores.id とたどって決まる。
-- stores.id が空文字の行と、そこに紐付く staff_members 行があると、アプリ側の
-- 「店舗あり」判定と「スコープなし = 全店舗」判定が同じ値を逆に読む余地ができる。
-- アプリ側 (staffHasStore / storeScopeMembership) は空文字を「店舗なし」に揃えたので
-- 実際の穴は塞がっているが、そもそも空文字の店舗が存在できないほうが前提が 1 つ減る。
--
-- CHECK は既存テーブルに後から足せない (テーブル作り直しになり、stores を参照する
-- 外部キーを全部張り直す羽目になる) ので、同じ不変条件をトリガで置く。
-- UPDATE 側を `UPDATE OF id` に限定しているのは、店名や営業設定の更新を巻き込まないため。
--
-- 店舗作成 API は既に空 ID を拒否するので、正規の経路がこのトリガに当たることはない。
-- 当たるのは誤った seed か直接の DB 操作だけで、それがこのトリガの対象。

CREATE TRIGGER IF NOT EXISTS trg_stores_id_not_blank_insert
BEFORE INSERT ON stores
FOR EACH ROW
WHEN trim(NEW.id, char(32, 9, 10, 13, 12288)) = ''
BEGIN
  SELECT RAISE(ABORT, 'store_id_blank');
END;

CREATE TRIGGER IF NOT EXISTS trg_stores_id_not_blank_update
BEFORE UPDATE OF id ON stores
FOR EACH ROW
WHEN trim(NEW.id, char(32, 9, 10, 13, 12288)) = ''
BEGIN
  SELECT RAISE(ABORT, 'store_id_blank');
END;

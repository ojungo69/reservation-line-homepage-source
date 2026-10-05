-- 顧客タブ (admin SPA) を staff が開くときの、オーナー承認ワンタイムコード・ゲート。
-- 1 行 = 1 チャレンジ。verify に成功した行がそのまま承認になる (verified_at / granted_until
-- が入る) ので、承認用の 2 つ目のテーブルは作らない。D1 は BEGIN/COMMIT を code 7500 で
-- 拒否するのでトランザクション文は書かない。
CREATE TABLE IF NOT EXISTS admin_customer_gate_challenges (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  -- sha256Hex(`${id}:${code}`)。生の 6 桁コードは保存しない。
  -- id (UUID) を混ぜるのは、10^6 しかないコード空間に対する事前計算表を無効にするため。
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified_at TEXT,
  granted_until TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 承認の有無はリクエストごとに引くので、生きている承認だけを持つ部分インデックスにする。
CREATE INDEX IF NOT EXISTS idx_admin_customer_gate_grant
  ON admin_customer_gate_challenges(admin_user_id, granted_until)
  WHERE granted_until IS NOT NULL;

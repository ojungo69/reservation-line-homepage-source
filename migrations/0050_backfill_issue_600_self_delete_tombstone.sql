-- Backfill terminal reservation event tombstones and close matching false conflicts.
--
-- 背景: 自分たちが削除した予約イベントの tombstone を full walk が拾うたびに
-- reservation_marker_mismatch が open していた（削除経路で抑止済み）。抑止が効くのは
-- google_calendar_events が「自分の DELETE の跡」の形をしている場合だけで、具体的には
-- reservation_id が入っている / source_type='reservation' / status='deleted' の 3 つを見る。
--
-- ところが conflict が open した時点で recordGoogleEventConflict が同じ台帳行を
-- upsert し直しており、status='conflict' に加えて source_type='unknown'・
-- reservation_id=NULL まで潰れている（marker mismatch の記録は sourceType を渡さないため
-- 既定の 'unknown' になり、reservation_id は sourceType='reservation' のときしか書かれない）。
-- そのため既存分は抑止条件を 3 つとも外し、手で resolve しても次の full walk でまた open する。
-- full walk は timeMin = now - 30 日 / timeMax 無しなので、放置すると予約開始日が 30 日前に
-- なるまで繰り返す。
--
-- 新規の削除では起きない（delete 経路が 3 列とも正しく書く）。壊れたまま残るのは
-- 「conflict が台帳行の最後の書き手になった」既存分だけなので、一度きりの backfill で足りる。
--
-- ⚠️ status='deleted' だけを根拠に書き戻してはいけない。orphan sweep が同じ値を書くため
-- 「自分が消した」証明にならない（status だけでは provenance を証明できない）。
-- ここでは代わりに、コード側の抑止と同じ証拠 —— 予約がその event id を手放していること ——
-- を条件にする。具体的には marker mismatch の conflict が名指ししている予約が終端状態で、
-- かつ reservations.google_event_id が NULL であること。
--
-- BEGIN/COMMIT は書かない（D1 は code 7500 で拒否する。0017 の注記を参照）。
-- 冪等: 1 文目は source_type='unknown' AND reservation_id IS NULL、2 文目は
-- resolution_status='open' を条件にしているので、再実行しても何もマッチしない。

-- 1) 台帳行を「自分の DELETE の跡」に戻す。
--    COUNT(DISTINCT ...) = 1 で、書き戻す reservation_id が一意に決まる場合だけ触る
--    （複数の予約が同じ event id を名指ししていたら、どれが正しいか決められないので放置する）。
--    この一意性は「終端予約に絞る前」の全 marker mismatch で数える —— 絞ったあとで数えると、
--    条件を満たさない別の予約が同じ event を名乗っていても 1 件に見えてしまう。
--    他種別の open な conflict が乗っている event も触らない（要対応の状態を勝手に変えない）。
--
--    marker が名指しする予約は、その台帳行と**同じ store のもの**でなければならない。
--    別 store の終端予約 ID を marker に書けば、他店の予約状態を根拠に台帳を書き換えられてしまう。
--
--    ⚠️ reservations だけでなく external_blocks も除外する。カレンダー編集権限を持つ第三者は、
--    生きている外部ブロックの event に終端予約の marker を付けるだけで、この backfill の対象になる
--    形（marker mismatch → 台帳行が unknown/conflict）を作れてしまう。そこで「自分の DELETE の跡」
--    を与えると、その event を消したときに 削除経路の抑止が発火し、外部ブロックの削除検知が消える
--    （D1 側にブロックと slot_locks が残り、枠が塞がったままになる）。
UPDATE google_calendar_events
SET status = 'deleted',
    source_type = 'reservation',
    reservation_id = (
      SELECT MIN(c.reservation_id)
      FROM google_calendar_conflicts c
      JOIN reservations r ON r.id = c.reservation_id
      WHERE c.calendar_id = google_calendar_events.calendar_id
        AND c.google_event_id = google_calendar_events.google_event_id
        AND c.conflict_type = 'reservation_marker_mismatch'
        AND c.store_id = google_calendar_events.store_id
        AND r.store_id = google_calendar_events.store_id
        AND r.status IN ('rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_admin')
        AND r.google_event_id IS NULL
    )
WHERE google_calendar_events.status IN ('conflict', 'deleted')
  AND google_calendar_events.source_type = 'unknown'
  AND google_calendar_events.reservation_id IS NULL
  -- Google 側で実際に消えている (tombstone) ことを、保存済みスナップショットで確かめる。
  -- conflict の upsert は「生きているイベントに終端予約の marker が付いていた」ケースでも
  -- 同じ unknown/conflict 形状を作るので、内部 status だけでは tombstone と区別できない。
  -- json_valid で包んでいるのは、壊れた JSON で migration 全体が落ちないようにするため
  -- (その行は NULL 比較になって対象外 = fail-closed)。
  AND CASE
        WHEN json_valid(google_calendar_events.google_safe_snapshot_json)
        THEN json_extract(google_calendar_events.google_safe_snapshot_json, '$.status')
      END = 'cancelled'
  AND EXISTS (
    SELECT 1
    FROM google_calendar_conflicts c
    JOIN reservations r ON r.id = c.reservation_id
    WHERE c.calendar_id = google_calendar_events.calendar_id
      AND c.google_event_id = google_calendar_events.google_event_id
      AND c.conflict_type = 'reservation_marker_mismatch'
      AND c.store_id = google_calendar_events.store_id
      AND CASE
            WHEN json_valid(c.google_safe_snapshot_json)
            THEN json_extract(c.google_safe_snapshot_json, '$.status')
          END = 'cancelled'
      AND r.store_id = google_calendar_events.store_id
      AND r.status IN ('rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_admin')
      AND r.google_event_id IS NULL
  )
  AND (
    SELECT COUNT(DISTINCT c.reservation_id)
    FROM google_calendar_conflicts c
    WHERE c.calendar_id = google_calendar_events.calendar_id
      AND c.google_event_id = google_calendar_events.google_event_id
      AND c.conflict_type = 'reservation_marker_mismatch'
  ) = 1
  AND NOT EXISTS (
    SELECT 1
    FROM reservations r2
    WHERE r2.google_event_id = google_calendar_events.google_event_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM external_blocks b
    WHERE b.google_event_id = google_calendar_events.google_event_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM google_calendar_conflicts o
    WHERE o.calendar_id = google_calendar_events.calendar_id
      AND o.google_event_id = google_calendar_events.google_event_id
      AND o.conflict_type <> 'reservation_marker_mismatch'
      AND o.resolution_status = 'open'
  );

-- 2) 誤報だった open な conflict を閉じる。
--    条件は 2 段構え。
--    (a) 台帳行が 1) の出力の形（status='deleted' / source_type='reservation' /
--        reservation_id = この conflict の marker）になっていること。
--    (b) それに加えて 1) の安全条件を**もう一度全部**確かめること。
--
--    ⚠️ (a) だけでは足りない。orphan sweep は reservation_id と source_type を残したまま
--    status だけを 'deleted' にするので、「生きている予約がその event を持ったまま、台帳だけ
--    deleted になっている」状態でも (a) は成立してしまう。そこで conflict を閉じると、
--    イベント消失・改変を示す唯一の open conflict が消える。形は 1) が動いた証拠にならない
--    —— これは 削除経路と同じ provenance の罠なので、条件を重複して書いてでも防ぐ。
--    1) と同じファイル内で先に走るので、(a) の EXISTS は 1) の結果を見ている。
UPDATE google_calendar_conflicts
SET resolution_status = 'ignored',
    resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    resolved_by = 'system:issue_600_self_delete_tombstone'
WHERE conflict_type = 'reservation_marker_mismatch'
  AND resolution_status = 'open'
  AND reservation_id IS NOT NULL
  -- この conflict 自身が tombstone を見て記録されたものであること。台帳の snapshot は観測ごとに
  -- 上書きされるが、conflict 行は同じ event/type の open が既にあると INSERT を省略するので、
  -- 「生きているイベントで本物の mismatch が open → あとで削除された」順序だと
  -- 台帳だけ cancelled になり conflict は confirmed のまま残る。台帳側だけ見ると閉じてしまう。
  AND CASE
        WHEN json_valid(google_calendar_conflicts.google_safe_snapshot_json)
        THEN json_extract(google_calendar_conflicts.google_safe_snapshot_json, '$.status')
      END = 'cancelled'
  -- (a) 1) の出力の形になっている
  AND EXISTS (
    SELECT 1
    FROM google_calendar_events e
    WHERE e.calendar_id = google_calendar_conflicts.calendar_id
      AND e.google_event_id = google_calendar_conflicts.google_event_id
      AND e.store_id = google_calendar_conflicts.store_id
      AND CASE
            WHEN json_valid(e.google_safe_snapshot_json)
            THEN json_extract(e.google_safe_snapshot_json, '$.status')
          END = 'cancelled'
      AND e.status = 'deleted'
      AND e.source_type = 'reservation'
      AND e.reservation_id = google_calendar_conflicts.reservation_id
  )
  -- (b) 1) の安全条件をここでも全部確かめる
  AND EXISTS (
    SELECT 1
    FROM reservations r
    WHERE r.id = google_calendar_conflicts.reservation_id
      AND r.store_id = google_calendar_conflicts.store_id
      AND r.status IN ('rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_admin')
      AND r.google_event_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM reservations r2
    WHERE r2.google_event_id = google_calendar_conflicts.google_event_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM external_blocks b
    WHERE b.google_event_id = google_calendar_conflicts.google_event_id
  )
  AND (
    SELECT COUNT(DISTINCT c2.reservation_id)
    FROM google_calendar_conflicts c2
    WHERE c2.calendar_id = google_calendar_conflicts.calendar_id
      AND c2.google_event_id = google_calendar_conflicts.google_event_id
      AND c2.conflict_type = 'reservation_marker_mismatch'
  ) = 1
  AND NOT EXISTS (
    SELECT 1
    FROM google_calendar_conflicts o
    WHERE o.calendar_id = google_calendar_conflicts.calendar_id
      AND o.google_event_id = google_calendar_conflicts.google_event_id
      AND o.conflict_type <> 'reservation_marker_mismatch'
      AND o.resolution_status = 'open'
  );

import { generateVAPIDKeys } from "web-push-neo";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AdminUser } from "../src/admin/access";
import { createAdminExternalBlock, cancelAdminExternalBlock } from "../src/admin/external-blocks";
import { savePushSubscription, deletePushSubscription, sendAdminPushTest } from "../src/notifications/admin-push";
import { autoCompleteReservations } from "../src/reservations/auto-complete";
import { requestCustomerGateCode, verifyCustomerGateCode } from "../src/admin/customer-gate";
import { commitAdminRecurring } from "../src/admin/recurring-commit";
import { linkLineFriend, syncLineFriendDirectory } from "../src/admin/line-friends";
import { approveAllDayAsClosure, rejectAllDayConflict, approveReservationDeleteAsCancel, rejectReservationDeleteConflict } from "../src/admin/conflict-resolutions";
import { retryAdminSyncJob, acknowledgeAdminSyncJob, resolveAdminGoogleConflict } from "../src/admin/sync-recovery";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";
import { insertAdminUser } from "./helpers/admin-access";

const admin: AdminUser = { id: "remaining_actor", email: "actor@example.test", role: "system_admin", staff_member_id: "staff_owner_kyoto", store_id: "kyoto" };
const now = () => Date.parse("2026-09-29T00:00:00.000Z");
const createRequest = { idempotencyKey: "remaining_create", storeId: "kyoto", resourceId: "resource_kyoto_calendar", startAt: "2099-07-01T01:00:00.000Z", endAt: "2099-07-01T02:00:00.000Z" };
const seed = () => {
  const db = createMigratedSqliteD1();
  insertAdminUser(db, { id: admin.id, email: admin.email, accessSubject: "remaining-sub", role: admin.role, staffMemberId: admin.staff_member_id });
  return db;
};
const snapshot = (db: SqliteD1Database) => Object.fromEntries(
  (db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, db.sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])
);
const revocations = [
  ["disabled", "UPDATE admin_users SET active=0 WHERE id='remaining_actor'"],
  ["role changed", "UPDATE admin_users SET role=CASE role WHEN 'staff' THEN 'owner' ELSE 'staff' END WHERE id='remaining_actor'"],
  ["store moved", "UPDATE staff_members SET store_id='osaka' WHERE id='staff_owner_kyoto'"]
] as const;
type Mutation = { name: string; setup?: (db: SqliteD1Database) => void; run: (db: D1Database) => Promise<{ ok: boolean; reason?: string; error?: string }> };
const blockSetup = (db: SqliteD1Database) => db.sqlite.exec("INSERT INTO external_blocks(id,store_id,resource_id,source,start_at,end_at,status,created_by) VALUES ('remaining_block','kyoto','resource_kyoto_calendar','admin_block','2099-07-01T01:00:00.000Z','2099-07-01T02:00:00.000Z','active','remaining_actor')");
const jobSetup = (db: SqliteD1Database) => db.sqlite.exec("INSERT INTO google_calendar_import_jobs(id,store_id,calendar_id,reason,status,dedupe_key) VALUES ('remaining_job','kyoto','calendar','manual','dead','remaining_job')");
const conflictSetup = (db: SqliteD1Database) => db.sqlite.exec("INSERT INTO google_calendar_conflicts(id,store_id,calendar_id,google_event_id,conflict_type,google_safe_snapshot_json,resolution_status) VALUES ('remaining_conflict','kyoto','calendar-a@example.invalid','event','external_event','{}','open')");
const allDaySetup = (db: SqliteD1Database) => {
  conflictSetup(db);
  db.sqlite.prepare("UPDATE google_calendar_conflicts SET conflict_type='google_all_day_event', google_safe_snapshot_json=? WHERE id='remaining_conflict'").run(JSON.stringify({start_at:"2099-07-01T00:00:00.000Z",end_at:"2099-07-02T00:00:00.000Z"}));
};
const reservationSetup = (db: SqliteD1Database) => db.sqlite.exec(`
  INSERT INTO customers(id,display_name) VALUES ('remaining_customer','Customer');
  INSERT INTO reservations(id,store_id,service_id,resource_id,customer_id,source,status,start_at,end_at,duration_minutes,idempotency_key)
  VALUES ('remaining_reservation','kyoto','service_kyoto_default_60','resource_kyoto_calendar','remaining_customer','admin','confirmed','2026-09-01T01:00:00.000Z','2026-09-01T02:00:00.000Z',60,'remaining_reservation');
`);
const deleteConflictSetup = (db: SqliteD1Database) => {
  conflictSetup(db); reservationSetup(db);
  db.sqlite.exec("UPDATE google_calendar_conflicts SET conflict_type='reservation_event_deleted', reservation_id='remaining_reservation'");
};
const resolutionMutations: Mutation[] = [
  { name: "all day approve", setup: allDaySetup, run: db => approveAllDayAsClosure({ db, admin, conflictId: "remaining_conflict", request: { idempotencyKey: "all-day" }, now }) },
  { name: "all day reject", setup: allDaySetup, run: db => rejectAllDayConflict({ db, admin, conflictId: "remaining_conflict", request: { idempotencyKey: "all-day" }, now }) },
  { name: "delete approve", setup: deleteConflictSetup, run: db => approveReservationDeleteAsCancel({ db, admin, conflictId: "remaining_conflict", request: { idempotencyKey: "delete", reason: null }, now }) },
  { name: "delete reject", setup: deleteConflictSetup, run: db => rejectReservationDeleteConflict({ db, admin, conflictId: "remaining_conflict", request: { idempotencyKey: "delete", reason: null }, now }) }
];
const lineUserId = "U" + "a".repeat(32);
const friendSetup = (db: SqliteD1Database) => {
  reservationSetup(db);
  db.sqlite.prepare("INSERT INTO line_friend_directory(channel_id,line_user_id,profile_status,display_name) VALUES ('channel',?,'fetched','Friend')").run(lineUserId);
};
const recurringRequest = { idempotencyKey:"remaining_recurring",storeId:"kyoto",resourceId:"resource_kyoto_calendar",rrule:"RRULE:FREQ=DAILY;COUNT=3",dtstart:"2099-07-01T01:00:00.000Z",windowEnd:"2099-07-04T00:00:00.000Z",durationMinutes:30 };
const staffAdmin = { ...admin, role: "staff" as const };
const gateStaffSetup = (db: SqliteD1Database) => db.sqlite.exec("UPDATE admin_users SET role='staff' WHERE id='remaining_actor'");
const codeSetup = (db: SqliteD1Database) => {
  gateStaffSetup(db);
  db.sqlite.prepare("INSERT INTO admin_customer_gate_challenges(id,admin_user_id,code_hash,expires_at) VALUES ('challenge','remaining_actor',?,'2099-01-01T00:00:00.000Z')")
    .run(createHash("sha256").update("challenge:123456").digest("hex"));
};
const subscription = {endpoint:"https://web.push.apple.com/remaining",p256dh:"synthetic",auth:"synthetic"};
const subscriptionSetup=(db:SqliteD1Database)=>db.sqlite.prepare("INSERT INTO admin_push_subscriptions(endpoint,admin_user_id,p256dh,auth) VALUES (?,?,?,?)").run(subscription.endpoint,admin.id,subscription.p256dh,subscription.auth);
const mutations: Mutation[] = [
  { name:"push subscription", run:db=>savePushSubscription(db,admin,subscription) },
  { name:"push unsubscribe", setup:subscriptionSetup,run:db=>deletePushSubscription(db,admin,subscription.endpoint) },
  { name: "admin auto complete", setup: reservationSetup, run: db => autoCompleteReservations({db,admin,now}) },
  { name: "customer gate request", setup: gateStaffSetup, run: db => requestCustomerGateCode({db,admin:staffAdmin,env:{PENDING_APPROVAL_OWNER_EMAIL:"owner@example.test",EMAIL:{send:async()=>{}}} as never}) },
  { name: "customer gate verify", setup: codeSetup, run: db => verifyCustomerGateCode({db,admin:staffAdmin,challengeId:"challenge",code:"123456"}) },
  { name: "recurring commit", run: db => commitAdminRecurring({db,admin,request:recurringRequest,now}) },
  { name: "LINE friend link", setup: friendSetup, run: db => linkLineFriend({ db, admin, channelId: "channel", lineUserId, request: { mode: "existing", customerId: "remaining_customer", storeId: "kyoto" }, now }) },
  { name: "LINE directory sync", run: db => syncLineFriendDirectory({ db, admin, channelId: "channel", token: "synthetic", now, fetcher: async url => String(url).includes("followers/ids") ? Response.json({userIds:[lineUserId]}) : Response.json({displayName:"Friend",userId:lineUserId}) }) },
  ...resolutionMutations,
  { name: "sync retry", setup: jobSetup, run: db => retryAdminSyncJob({ db, admin, request: { idempotencyKey: "retry", source: "google_calendar_import_jobs", jobId: "remaining_job" }, now }) },
  { name: "sync acknowledge", setup: jobSetup, run: db => acknowledgeAdminSyncJob({ db, admin, request: { idempotencyKey: "ack", source: "google_calendar_import_jobs", jobId: "remaining_job", note: "Reviewed" }, now }) },
  ...(["ignored", "manual_resolved"] as const).map(resolutionStatus => ({ name: `conflict ${resolutionStatus}`, setup: conflictSetup, run: (db: D1Database) => resolveAdminGoogleConflict({ db, admin, conflictId: "remaining_conflict", resolutionStatus, request: { idempotencyKey: "resolve" }, now }) })),
  { name: "external block create", run: db => createAdminExternalBlock({ db, admin, request: createRequest, now }) },
  { name: "external block cancel", setup: blockSetup, run: db => cancelAdminExternalBlock({ db, admin, externalBlockId: "remaining_block", request: { idempotencyKey: "remaining_cancel" }, now }) }
];

describe("remaining admin write authorization", () => {
  for (const mutation of mutations) {
    it(`${mutation.name}: current actor succeeds`, async () => {
      const db = seed();
      try {
        mutation.setup?.(db);
        expect((await mutation.run(db as unknown as D1Database)).ok).toBe(true);
        expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='admin.write.guard'").get()).toEqual({ n: 0 });
      } finally { db.sqlite.close(); }
    });
    it.each(revocations)(`${mutation.name}: %s at write boundary leaves no side effects`, async (_label, sql) => {
      const db = seed();
      try {
        mutation.setup?.(db);
        const batch = db.batch.bind(db);
        let before: ReturnType<typeof snapshot> | undefined;
        db.batch = async statements => {
          if (!before) { db.sqlite.exec(sql); before = snapshot(db); }
          return batch(statements);
        };
        const result = await mutation.run(db as unknown as D1Database);
        expect(before).toBeDefined();
        expect(result.ok).toBe(false);
        expect(result.reason ?? result.error).toBe("forbidden");
        expect(snapshot(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    });
  }
});

for (const mutation of resolutionMutations) {
  it(`${mutation.name}: revocation after claim restores only its own conflict`, async () => {
    const db = seed();
    try {
      mutation.setup?.(db);
      const batch=db.batch.bind(db);
      let calls=0;
      db.batch=async statements=>{
        if (++calls===2) db.sqlite.exec("UPDATE admin_users SET active=0 WHERE id='remaining_actor'");
        return batch(statements);
      };
      const result=await mutation.run(db as unknown as D1Database);
      expect(result).toMatchObject({ok:false,reason:"forbidden"});
      expect(db.sqlite.prepare("SELECT resolution_status,resolved_by FROM google_calendar_conflicts WHERE id='remaining_conflict'").get()).toEqual({resolution_status:"open",resolved_by:null});
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({n:0});
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get()).toEqual({n:0});
    } finally {db.sqlite.close();}
  });
}

it.each(["archived_at='2026-09-29'", "merged_into_id='merge_target'", "block_status='blocked'"])("LINE linking preserves current target: %s", async change => {
  const db=seed();
  try {
    friendSetup(db);
    db.sqlite.exec("INSERT INTO customers(id,display_name) VALUES ('merge_target','Target')");
    const batch=db.batch.bind(db);
    db.batch=async statements=>{db.sqlite.exec(`UPDATE customers SET ${change} WHERE id='remaining_customer'`);return batch(statements);};
    const result=await linkLineFriend({db:db as unknown as D1Database,admin,channelId:"channel",lineUserId,request:{mode:"existing",customerId:"remaining_customer",storeId:"kyoto"},now});
    expect(result.ok).toBe(false);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM line_identities").get()).toEqual({n:0});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get()).toEqual({n:0});
  } finally {db.sqlite.close();}
});

it("recurring revocation preserves completed children and permits a later authorized resume", async () => {
  const db=seed();
  try {
    const batch=db.batch.bind(db); let calls=0;
    db.batch=async statements=>{if(++calls===3) db.sqlite.exec("UPDATE admin_users SET active=0 WHERE id='remaining_actor'");return batch(statements);};
    expect(await commitAdminRecurring({db:db as unknown as D1Database,admin,request:recurringRequest,now})).toMatchObject({ok:false,error:"forbidden"});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM external_blocks").get()).toEqual({n:1});
    expect(db.sqlite.prepare("SELECT status FROM idempotency_keys WHERE idempotency_key='remaining_recurring'").get()).toEqual({status:"failed"});
    db.batch=batch; db.sqlite.exec("UPDATE admin_users SET active=1 WHERE id='remaining_actor'");
    expect(await commitAdminRecurring({db:db as unknown as D1Database,admin,request:recurringRequest,now})).toMatchObject({ok:true,createdCount:2,replayedCount:1});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM external_blocks").get()).toEqual({n:3});
  } finally {db.sqlite.close();}
});

it("gate revocation between committed issuance and email prevents sending and removes only its new challenge", async () => {
  const db=seed(); const send=vi.fn(async()=>{});
  try {
    gateStaffSetup(db);
    const batch=db.batch.bind(db);let calls=0;
    db.batch=async statements=>{if(++calls===2) db.sqlite.exec("UPDATE admin_users SET active=0 WHERE id='remaining_actor'");return batch(statements);};
    expect(await requestCustomerGateCode({db:db as unknown as D1Database,admin:staffAdmin,env:{PENDING_APPROVAL_OWNER_EMAIL:"owner@example.test",EMAIL:{send}} as never})).toEqual({ok:false,reason:"forbidden"});
    expect(send).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_customer_gate_challenges").get()).toEqual({n:0});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='customer_gate_code_requested'").get()).toEqual({n:1});
  } finally {db.sqlite.close();}
});

it("push test stops before provider POST when actor is revoked during encryption",async()=>{
  const db=seed(); const fetcher=vi.fn(async()=>new Response(null,{status:201}));
  try {
    const vapid=await generateVAPIDKeys();const device=await generateVAPIDKeys();
    db.sqlite.prepare("INSERT INTO admin_push_subscriptions(endpoint,admin_user_id,p256dh,auth) VALUES (?,?,?,?)").run(subscription.endpoint,admin.id,device.publicKey,Buffer.from("test-auth-secret").toString("base64url"));
    const batch=db.batch.bind(db);let calls=0;
    db.batch=async statements=>{
      if(++calls===2) db.sqlite.exec("UPDATE admin_users SET active=0 WHERE id='remaining_actor'");
      return batch(statements);
    };
    const result=await sendAdminPushTest({VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey,OPERATIONS_NOTIFICATION_EMAIL:"ops@example.test"},db as unknown as D1Database,admin,fetcher);
    expect(result).toMatchObject({ok:false,reason:"forbidden"});
    expect(fetcher).not.toHaveBeenCalled();
  } finally {db.sqlite.close();}
});

it("directory sync stops after the already committed chunk when authorization changes",async()=>{
  const db=seed();
  const ids=Array.from({length:201},(_,i)=>"U"+i.toString(16).padStart(32,"0"));
  const fetcher=vi.fn(async()=>Response.json({userIds:ids}));
  try {
    const batch=db.batch.bind(db);let calls=0;
    db.batch=async statements=>{if(++calls===3) db.sqlite.exec("UPDATE admin_users SET active=0 WHERE id='remaining_actor'");return batch(statements);};
    expect(await syncLineFriendDirectory({db:db as unknown as D1Database,admin,channelId:"channel",token:"synthetic",fetcher,now})).toEqual({ok:false,error:"forbidden"});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM line_friend_directory").get()).toEqual({n:100});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get()).toEqual({n:0});
  } finally {db.sqlite.close();}
});
it("directory profile response cannot write after revocation",async()=>{
  const db=seed();
  try {
    const fetcher=vi.fn(async url=>{
      if(String(url).includes("followers/ids")) return Response.json({userIds:[lineUserId]});
      db.sqlite.exec("UPDATE admin_users SET active=0 WHERE id='remaining_actor'");
      return Response.json({displayName:"New profile",userId:lineUserId});
    });
    expect(await syncLineFriendDirectory({db:db as unknown as D1Database,admin,channelId:"channel",token:"synthetic",fetcher,now})).toEqual({ok:false,error:"forbidden"});
    expect(db.sqlite.prepare("SELECT profile_status,display_name FROM line_friend_directory").get()).toEqual({profile_status:"pending",display_name:null});
  } finally {db.sqlite.close();}
});
it("admin auto completion stops between reservations while cron remains autonomous",async()=>{
  const db=seed();
  try {
    reservationSetup(db);
    db.sqlite.exec(`INSERT INTO reservations(id,store_id,service_id,resource_id,customer_id,source,status,start_at,end_at,duration_minutes,idempotency_key)
      SELECT 'second_reservation',store_id,service_id,resource_id,customer_id,source,status,start_at,end_at,duration_minutes,'second_reservation' FROM reservations WHERE id='remaining_reservation'`);
    const batch=db.batch.bind(db);let calls=0;
    db.batch=async statements=>{if(++calls===2) db.sqlite.exec("UPDATE admin_users SET active=0 WHERE id='remaining_actor'");return batch(statements);};
    expect(await autoCompleteReservations({db:db as unknown as D1Database,admin,now})).toEqual({ok:false,reason:"forbidden"});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status='completed'").get()).toEqual({n:1});
    db.batch=batch;
    expect(await autoCompleteReservations({db:db as unknown as D1Database,now})).toMatchObject({ok:true,completedCount:1});
  } finally {db.sqlite.close();}
});
it("an unrelated database failure keeps write_failed instead of becoming a permission denial",async()=>{
  const db=seed();
  try {
    db.batch=async()=>{throw new Error("synthetic D1 failure");};
    expect(await createAdminExternalBlock({db:db as unknown as D1Database,admin,request:createRequest,now})).toEqual({ok:false,reason:"write_failed"});
  } finally {db.sqlite.close();}
});
it("recurring finalization rejects a revoked actor without an orphan summary audit",async()=>{
  const db=seed();
  try {
    const batch=db.batch.bind(db);let calls=0;
    db.batch=async statements=>{if(++calls===5) db.sqlite.exec("UPDATE admin_users SET active=0 WHERE id='remaining_actor'");return batch(statements);};
    expect(await commitAdminRecurring({db:db as unknown as D1Database,admin,request:recurringRequest,now})).toMatchObject({ok:false,error:"forbidden"});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM external_blocks").get()).toEqual({n:3});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='settings.recurring.commit'").get()).toEqual({n:0});
    expect(db.sqlite.prepare("SELECT status FROM idempotency_keys WHERE idempotency_key='remaining_recurring'").get()).toEqual({status:"failed"});
  } finally {db.sqlite.close();}
});

it("gate refuses to send when its final authorization checkpoint cannot read D1", async () => {
  const db = seed();
  const send = vi.fn(async () => {});
  try {
    gateStaffSetup(db);
    const batch = db.batch.bind(db);
    let calls = 0;
    db.batch = async statements => {
      if (++calls === 2) throw new Error("synthetic D1 unavailable");
      return batch(statements);
    };
    await expect(requestCustomerGateCode({ db: db as unknown as D1Database, admin: staffAdmin,
      env: { PENDING_APPROVAL_OWNER_EMAIL: "owner@example.test", EMAIL: { send } } as never
    })).rejects.toThrow("synthetic D1 unavailable");
    expect(send).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_customer_gate_challenges").get()).toEqual({ n: 0 });
  } finally { db.sqlite.close(); }
});

it("push test propagates an authorization database failure and never posts", async () => {
  const db = seed();
  const fetcher = vi.fn(async () => new Response(null, { status: 201 }));
  try {
    const vapid = await generateVAPIDKeys();
    const device = await generateVAPIDKeys();
    db.sqlite.prepare("INSERT INTO admin_push_subscriptions(endpoint,admin_user_id,p256dh,auth) VALUES (?,?,?,?)")
      .run(subscription.endpoint, admin.id, device.publicKey, Buffer.from("test-auth-secret").toString("base64url"));
    const batch = db.batch.bind(db);
    let calls = 0;
    db.batch = async statements => {
      if (++calls === 2) throw new Error("synthetic D1 unavailable");
      return batch(statements);
    };
    await expect(sendAdminPushTest({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
      OPERATIONS_NOTIFICATION_EMAIL: "ops@example.test" }, db as unknown as D1Database, admin, fetcher
    )).rejects.toThrow("synthetic D1 unavailable");
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get()).toEqual({ n: 1 });
  } finally { db.sqlite.close(); }
});

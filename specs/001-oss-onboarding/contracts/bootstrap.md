# Bootstrap contract

Input: all current migrations applied to a fresh operator-owned database; SQL in seeds/bootstrap.sql.
Only synthetic identities and data are supplied. Operators copy/edit it in ignored local state.

Success: one kyoto store, one pending human owner, one service/resource/mapping and opening hours.
Refusal: stores, admin_users, customers or reservations already populated; repeated execution.
The first store INSERT fails its name NOT NULL constraint before any later bootstrap writes.

Identity: owner@example.invalid is a placeholder, not a working login. Replace it with the owner's
verified Access email before first installation. Access verification is unchanged; the pending row
binds to the verified subject once. Authentication is never bypassed.

Local checks: health pass; public options include one store/menu/resource. Provider integration
checks require the operator's accounts and must not be claimed from a local fixture run.

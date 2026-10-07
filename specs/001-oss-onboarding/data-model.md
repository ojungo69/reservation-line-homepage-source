# Initial installation data

Existing schema only: one stores row keyed kyoto; one canonical staff_login_kyoto owner; one active,
human admin_users row with fictional email and pending access_subject; one active resource; one
positive-duration service and its service_stores mapping; seven opening-hours rows. Optional
store_settings defaults are handled by existing application defaults/UPSERTs.

Transitions: empty schema -> bootstrap -> verified owner subject binding. After binding, a different
subject remains unregistered. Inactive owners remain inactive. Reapplication refuses without edits.

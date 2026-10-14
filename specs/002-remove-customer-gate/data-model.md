# Data model impact

No schema change in this feature.

| Data | After this change | Later |
|---|---|---|
| `admin_customer_gate_challenges` (created by immutable migration 0053) | no reads or writes from application code or tests; existing rows are ignored | dropped by a separate migration after this version runs in production |
| `audit_logs` rows with `customer_gate_code_requested`, `customer_gate_verified`, `customer_gate_verify_failed` | kept (append-only history); still rendered with readable labels | unchanged |
| `audit_logs` rows with `customer.list_view` (new) | one per staff member per JST day, id derived from the day, no customer data | unchanged |
| rate-limit rows keyed `admin_customer_gate_request`, `admin_customer_gate_request_hourly`, `admin_customer_gate_verify` | no longer created; existing rows expire through the normal rate-limit window | unchanged |

Staff authorization data (`admin_users.role`, `store_id`, `active`) and customer-to-store
relations are unchanged. Role and active-state changes no longer delete approval rows; nothing
reads them, and the later drop removes them.

The later drop must ship after this version is live, because the deployment applies migrations
before replacing the Worker: dropping the table in the same release would let the still-running
older version fail on its next approval lookup.

# New phone input policy

Status: approved policy; application-first implementation.

New contact input accepts domestic-shaped numbers (10–11 digits, starting with
0 then a nonzero digit) and explicit international numbers (+ and 8–15 digits,
starting with a nonzero digit). Existing Japanese country-code aliases continue
to normalize to the same domestic value. A +81 value that cannot be normalized
to the accepted domestic shape is rejected. Separator handling is unchanged.

Ambiguous bare foreign numbers, noncanonical international dialing strings,
zero-padding and +0 input are rejected instead of being guessed or rewritten.
This is a contact-format policy, not country allocation or ownership proof.

Existing normalization and read/search behavior remain unchanged. An existing
customer's on-file contact reused without new contact input remains usable.
Successful idempotent retries retain their existing normalized request identity
and replay before enforcing the new-input policy. CustomerId-based booking,
NULL/blank optional phone fields and masked profile echoes retain their contracts.

No database migration, existing phone/hash conversion, new parser dependency,
phone-suffix identity matching or provider operation is included.

Acceptance:

- All five contact-write entry points reject disallowed new input cleanly and
  without partial customer/reservation/lock/job/audit/idempotency writes.
- Accepted input keeps identical normalized bytes and hashes; booking blocks,
  role/store authorization and atomic manual phone-lock updates remain intact.
- Public form validation explains and enforces the policy, including current
  Japanese aliases and IME normalization, without changing submitted identity.
- Existing legacy normalization/search, recognized contact and successful replay
  are explicitly covered by regression tests.
- Any future strict DB guard requires a separate app-first rollout and reviewed
  old-Worker compatibility; it is excluded from this feature.

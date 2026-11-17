# Combined application release

This release combines the two corrections in [005](spec.md) with the approved
[006 phone input policy](../006-phone-input-policy/spec.md). The three changes
have separate implementation evidence and do not overlap in source files.

- Echo expiry compares instants while retaining the existing identity and etag
  predicates.
- The settings response type reflects staff-field omission; a shared fixture
  checks the actual menu dialog, hook and service endpoint contract.
- New phone input uses the approved domestic or explicit international format.
  Existing normalization, searches, hashes, stored-contact reuse and successful
  idempotent retries retain their contracts.

The combined release changes application code, tests and feature documentation
only. It adds no dependency, schema migration, database guard, quality-policy
change or provider operation. Minimo remains outside this release.

Complete combined static and runtime tests plus independent Standards/security
and Spec reviews before publishing. Then obtain public actual-main CI/Sonar
proof, adopt its exact revision privately while preserving overlays, all existing
migrations and the approved quality snapshot, and complete private CI, staging,
explicit promotion and live verification. [Tasks](tasks.md) T006–T009 remain open
until that evidence exists.

Rollback is a targeted reviewed application change on current main followed by
the same public/private proof and deployment process. Retain the current schema
and Google query/watch contracts. Reverting phone enforcement would reopen the
known input-format gap; no data conversion or restoration is needed.

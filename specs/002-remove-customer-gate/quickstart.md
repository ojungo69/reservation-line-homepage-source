# Validation guide

## Local

Run from the repository root after `npm ci` and `npm --prefix admin-app ci`:

```bash
npm run typecheck
npm run admin:typecheck
npm run test:unit
npm run test:worker
npm run admin:test
npm run knip
npm run admin:build
```

Expected: all pass. Leftover search (SC-004) prints only the historical migration, the kept audit
labels with their test, and this spec:

```bash
git grep -n -i -E "customer[-_]?gate|customerGate|admin_customer_gate" -- . ':!specs/'
```

Contract checks covered by tests (see [contracts/admin-api.md](contracts/admin-api.md)):

- staff of store A without any grant: list, search with memo, detail, visits, reservations,
  consents, memo/referrer/profile saves, visit-note save and customer creation succeed;
- the same staff member is refused for a customer belonging only to store B, and a staff member
  without a store is refused;
- `POST /api/admin/customer-gate/request` and `/verify` return the generic not-found body and send
  no email;
- role and active-state changes succeed without touching approval rows;
- historical audit actions render readable labels.

## Staging (operator)

1. Deploy the adopted private revision to staging.
2. Temporarily set one staging administrator to the staff role of one store, hard-reload the admin
   page, open the customer tab, a customer and a reservation detail; save a memo. No code card.
3. Open a customer of another store by direct link: refused.
4. Restore the administrator's original role and confirm it through the live API.

## Production (operator)

Promote the verified revision, then confirm with an authenticated owner session that
`POST /api/admin/customer-gate/request` returns the generic not-found body
(`{"error":"not_found"}`) and that the customer tab works.

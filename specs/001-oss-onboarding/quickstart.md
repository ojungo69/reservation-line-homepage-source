# Verification

1. npm ci --ignore-scripts; npm ci --ignore-scripts --prefix admin-app.
2. npm run test:unit -- test/publication-config.test.ts test/admin-access-pending-bind.test.ts.
3. Follow docs/INSTALL.md using a new .wrangler/oss-install persistence path; apply migrations,
   bootstrap, build admin assets, start Wrangler and inspect health/public options.
4. Expected: exactly one fictional store/menu/resource, pending-owner identity behavior preserved,
   existing-data refusal without edits, healthy local HTTP endpoints.
5. Review bootstrap security and guide completeness. Pass full public CI/security/Sonar before merge.
6. Treat the real provider-backed booking/approval checklist as an operator step.

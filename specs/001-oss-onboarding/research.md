# Research

- Fresh full migrations create no store/admin fixtures; menu backfills select existing stores.
  Decision: a dedicated bootstrap after all migrations, not deleting three development stores.
- access_subject is NOT NULL UNIQUE. Decision: pending:bootstrap-owner and the existing verified
  email/subject bind; neither NULL nor automatic account creation is valid.
- Store-login identity is canonical staff_login_kyoto. Decision: retain that technical key and owner
  role; display names and prices are fictional, replaceable installation data.
- Public-only publication-config.test.ts is intentionally independent from private operations.
  Decision: extend it; keep private product tests, managed shared helpers and quality policy intact.
- The earlier OSS has a distinct DO/owner-token runtime and open PR61. Decision: reuse its setup
  sequence only; preserve its active work and defer archival.
- Native Wrangler supports --local and --persist-to on migration, execute and dev commands.
  Decision: use isolated persistence and existing flags, without adding a setup CLI.
- Google live availability defaults on in Wrangler. Decision: explicitly disable it for local model
  checks until the operator configures calendar access; never weaken application authentication.

Primary platform references:
- https://developers.cloudflare.com/workers/wrangler/commands/d1/
- https://developers.cloudflare.com/d1/best-practices/local-development/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/

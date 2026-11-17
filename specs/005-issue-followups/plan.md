# Implementation Plan: validated correctness follow-ups

Branch: 005-issue-followups. Date: 2026-11-17. Spec: [spec.md](spec.md).

## Summary and technical context

First wave: reproducible echo expiry and settings response/fixture contracts. Existing Workers/Hono/D1, React, installed TypeScript and Vitest/native SQLite stay authoritative. CI uses Node24. No new dependency/schema. Narrow the lookup by existing indexed identity before parsing expiry; inspect query-plan effects.

Release composition: ship these two corrections together with the approved
[new phone input policy](../006-phone-input-policy/spec.md). Its implementation
and task evidence remain separate; see [combined release scope](release-scope.md).

## Constitution check

PASS before/after design: D1 authority, write-time role/scope, idempotency/claims, failure recovery, SQL history and quality gates stay. No new abstraction/trust boundary/dependency/migration. Keep credentials/customer data out of artifacts and Minimo release held. Shared public source precedes private adoption.

## Ownership and scope

Parent alone writes feature artifacts and final integration. Two implementation worktrees start at3f65 with one writer each. Expiry: src/google/import-sync.ts plus relevant importer regression tests. Settings: response type, current hook fixture, real boundary contract test and only consumers proven by typecheck. Any expansion needs concrete evidence and a recorded reason. Each child freezes hashes/patch/check results; no child performs release operations.

## Sequence and verification

1. Local bug assessment before editing, caller inspection and applicable graph impact. Warn on HIGH/CRITICAL before edits.
2. Reproduce actual behavior, make minimum correction, run focused tests/compilers. Integrate frozen child patches.
3. Standards/Spec and boundary review; expected scope checks. Reuse identical passed evidence only with byte proof.
4. Public PR and actual-main CI/Sonar, fixed-SHA private import/verify/quality preserving overlays and the complete approved quality snapshot.
5. Full private gates/review, actual-main evidence, staging, exact-SHA promotion/live verification.

## Risks and rollback

Malformed expiry is a nonmatch. Optional typing may expose callers that assumed privileged payloads; fix only proven cases. Keep contract tests at the real boundary. No real customer/provider writes. Existing rollback is a new targeted public/private pair retaining current DDL/query/watch/quality; DB restore is separate.

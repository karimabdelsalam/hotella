## What & why

<!-- One paragraph. Link the BUILD_PLAN section / task id (e.g. "Sprint 0.2 task 0.2.4"). -->

## Spec & rules touched

<!-- Which spec sections (docs/spec) and which CLAUDE.md rules does this change touch? How are they honoured? -->

## Gate A — Automated (CI must be green)

- [ ] oxlint · Prettier · dependency-cruiser · `tsgo` typecheck · build
- [ ] unit · integration (Testcontainers) · contract · e2e where applicable
- [ ] migration drift check · `en`/`ar` key parity · OpenAPI snapshot

## Gate B — Spec review

- [ ] Module Definition of Done (BUILD_PLAN §12) walked for every touched module
- [ ] Tenant/property scoping, permissions, audit, outbox, i18n, versioning verified in the diff

## Gate C — Docs sync

- [ ] BUILD_PLAN / ADRs / TRACEABILITY / CLAUDE.md / DEVELOPER_GUIDE updated if anything deviated or any command changed

## Gate D — Acceptance

<!-- Paste the result of the sprint/phase acceptance items this PR completes. -->

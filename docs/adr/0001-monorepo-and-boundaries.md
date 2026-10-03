# ADR-0001: Monorepo (pnpm + Turborepo) and bounded-context boundary enforcement

**Status:** Accepted — 2026-10-03

## Context
Spec §2.1 mandates a modular monolith with explicit bounded contexts that may later be extracted. Spec §77 suggests `/apps`, `/packages/domain`, `/packages/platform`, `/packages/contracts` and warns against `/domain` becoming an unstructured shared package. Spec §3 forbids one domain mutating another domain's tables.

## Decision
- Single repository, pnpm workspaces, Turborepo for task orchestration and caching. Node 22 LTS, TypeScript 5 `strict`.
- One pnpm package per bounded context under `packages/domain/<ctx>` named `@hotella/domain-<ctx>`; platform packages `@hotella/platform-*`; contracts `@hotella/contracts-*`.
- Each domain package exposes a `src/public` entrypoint (interfaces, DTO types, event names). ESLint `boundaries` rules:
  - `domain/*` may import `platform/*`, `contracts/*`, and other domains **only** via `@hotella/domain-<other>/public`.
  - `platform/*` may not import `domain/*`.
  - `contracts/*` imports nothing but zod and other contracts.
  - `apps/*` may import anything (they compose modules).
- Lint failure on violation is a CI failure.
- Spec §77 lists ten suggested domain packages. We keep all of them and add, as separate bounded contexts with their own PostgreSQL schema, the contexts the spec names in §3 but did not list in §77: `catalog` (Service Catalog, §7), `inspections` (§11), `relations` (§12), `lostfound` (§13), `logbook` (§14), `knowledge` (§37) and `audit` (§68). This is an elaboration, not a deviation: §77 is explicitly "suggested" and §3 is the authoritative context list.

## Consequences
- Extracting a context into a service later means moving a package and replacing `/public` calls with network calls; the contract already exists.
- Cross-domain data reads happen through application services or read models, never joins across schemas in domain code.
- Some duplication of DTO types between `/public` and `/application` is accepted in exchange for isolation.

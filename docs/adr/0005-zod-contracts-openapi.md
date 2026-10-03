# ADR-0005: Zod as the single contract language, OpenAPI generated

**Status:** Accepted — 2026-10-03

## Context
The same shapes are needed for HTTP DTOs (Spec §74, OpenAPI), event payloads (§51), AI tool input/output schemas (§31, §42 schema validation), connector manifests/config/credential schemas (§56), inspection item and asset-type dynamic schemas (§10.2, §11). Class-validator decorators cannot be reused for events, tools or stored dynamic schemas.

## Decision
- **Zod 4** schemas are the source of truth for all contracts, living in `packages/contracts/*`.
- API: NestJS 12 **Standard Schema** support — zod schemas are passed directly to `@Body()/@Query()/@Param()`; no adapter library. OpenAPI 3.1 is generated from the same schemas with `z.toJSONSchema()` + `@nestjs/swagger` 12, served at `/api/docs` outside production and snapshot-tested in CI.
- Events, AI tools and connector manifests reference the same schema objects.
- Dynamic business schemas stored in JSONB (asset type properties, service required fields, inspection items) are stored as JSON Schema and validated with a JSON Schema validator at runtime; zod is for compile-time-known contracts.

## Consequences
- One validation style across the codebase; generated TypeScript types from `z.infer`.
- Contract packages must stay dependency-light (zod only) so the future frontend and the connector SDK can consume them.

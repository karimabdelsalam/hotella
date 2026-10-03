# ADR-0018: AI Model Gateway, provider adapters and data egress policy

**Status:** Accepted for the engineering design — 2026-10-03. **Pending product-owner decision (BUILD_PLAN Q8):**
which external provider(s) may be enabled for the pilot and the monthly budget caps. Until then installations run
with AI providers disabled, or with an on-prem model server only.

## Context
Spec §27–§28 require a provider-independent AI layer: every model call passes one gateway that routes by capability
(`REASONING_HIGH`, `FAST_CLASSIFICATION`, `VISION`, `TRANSLATION`, `EMBEDDING`, `AUDIO`, `STRUCTURED_OUTPUT`), falls
back, records cost and latency, and honours kill switches. Spec §42 requires that data sent to providers passes
classification, redaction and provider policy. ADR-0013 places the platform on Planova-operated servers and Q7 keeps
data inside the installation; sending guest conversations to a cloud model is therefore a **data egress** decision,
and paying for tokens is a spending decision — both belong to the product owner.

## Decision

### Gateway and adapters
- `MODEL_GATEWAY` (public API of the `ai` context) is the only way to call a model: `complete()` for chat/tool use and
  structured output, `embed()` for embeddings. Callers name a **capability**, never a model.
- Adapters, behind one `ModelProvider` interface (HTTP via `fetch`, no vendor SDK — ADR-0016 keeps the dependency
  surface small and avoids SDK churn):
  - `OPENAI_COMPATIBLE` — the OpenAI Chat Completions/Embeddings wire format. Serves OpenAI itself **and** on-prem
    model servers that speak it (vLLM, Ollama, LM Studio, text-generation-inference).
  - `ANTHROPIC` — the Messages API (tool use, system prompts).
  - `FAKE` — deterministic, scripted responses for tests, CI and local development. Never registered in production
    builds' default routing.
  - Google and audio/vision providers are added the same way when a capability needs them.
- Credentials are `SecretRef`s per provider row (rule 13); base URLs are configuration (an on-prem server is just a
  base URL).
- Routing: `ai.routing_rules` map a capability to an ordered list of models (platform default, tenant and property
  overrides). The gateway tries them in order on retryable failures (timeouts, 429, 5xx) and records the fallback.
- Every call writes `ai.model_calls` (provider, model, capability, tokens in/out/cached, latency, estimated cost from
  the model's per-token prices, outcome, correlation id, execution id) — Spec §41.

### Data egress policy (deterministic, before every call)
- Each provider has a **maximum data class** it may receive (`PUBLIC` … `RESTRICTED`, the classification registry of
  Phase 0) and an `egress` flag: `ON_PREM` (inside the installation) or `EXTERNAL`.
- The Context Engine assembles context from tools and labels each part with its data class. Before a call the gateway
  removes parts above the provider's maximum and masks identifiers it recognises (phone numbers, e-mail addresses,
  document numbers) when the provider is `EXTERNAL`. RESTRICTED data (OTP seeds, tokens, payment data) never leaves
  the platform, whatever the provider.
- An `EXTERNAL` provider is used only if the platform setting `ai.external_providers.allowed` lists it **and** the
  tenant's setting `ai.external_providers.enabled` is true. Both default to off.

### Budget and kill switches
- Per-tenant monthly budget `ai.budget.monthly_limit_minor` (default 0 = no external spend allowed); when the
  estimated cost of the month's calls reaches it, external calls stop (on-prem providers continue) and an operational
  alert is raised once.
- Kill switches (Spec §42) as feature flags evaluated by the gateway and the runtime: provider, model, agent, tool,
  auto-actions, guest AI. A switched-off guest AI hands every conversation to staff.

## Consequences
- The whole AI foundation (Phase 6) is built and tested with the `FAKE` provider; CI never calls a paid API.
- A pilot can run AI fully on-prem by pointing `OPENAI_COMPATIBLE` at a local model server — no owner decision needed
  for that beyond hardware.
- Enabling Anthropic or OpenAI is configuration (provider row + SecretRef + the two settings + a budget), done after
  the product owner answers Q8.
- Provider-specific features (prompt caching, batch APIs) are optimisations inside adapters, never visible to agents.

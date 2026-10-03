# ADR-0018: AI Model Gateway, provider adapters and data egress policy

**Status:** Accepted — 2026-10-03. **Product-owner decision (BUILD_PLAN Q8), 2026-10-03:** external providers
**Anthropic (Claude) and OpenAI (ChatGPT)** may be enabled, both behind the gateway (either can be the fallback of the
other), with a spend cap of **100 USD per hotel per month**. The owner's framing: AI is a large part of the platform —
making work easier for staff and guests and powering analytics — but not all of it; the operational core stays
deterministic (rule 11) and keeps working when AI is off or over budget.

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
- Monthly budget per hotel `ai.budget.monthly_limit_minor` (scopes platform → tenant → property; default 10 000 minor
  units = 100 USD, the owner's cap); a call for a property counts that property's external spend of the month against
  its limit (a call without a property counts the tenant's). When it is reached, external calls stop for that hotel
  (on-prem providers continue, otherwise the AI hands over to staff) and an operational alert is raised once.
- Kill switches (Spec §42) as feature flags evaluated by the gateway and the runtime: provider, model, agent, tool,
  auto-actions, guest AI. A switched-off guest AI hands every conversation to staff.

## Consequences
- The whole AI foundation (Phase 6) is built and tested with the `FAKE` provider; CI never calls a paid API.
- A pilot can run AI fully on-prem by pointing `OPENAI_COMPATIBLE` at a local model server — no owner decision needed
  for that beyond hardware.
- Enabling Anthropic or OpenAI is configuration: a provider row per vendor (kinds `ANTHROPIC` and
  `OPENAI_COMPATIBLE`, egress `EXTERNAL`) with its API key as a SecretRef in OpenBao, its codes in the platform setting
  `ai.external_providers.allowed`, and the tenant's opt-in `ai.external_providers.enabled` (each hotel group switches
  external AI on deliberately). The 100 USD per hotel cap applies by default.
- Provider-specific features (prompt caching, batch APIs) are optimisations inside adapters, never visible to agents.

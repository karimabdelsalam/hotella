# HOTELLA
## Hotel Intelligence Platform
## Master Architecture & Engineering Specification

**Status:** Architecture Baseline / Source of Truth  
**Version:** 1.0  
**Date:** 2026-10-03  
**Audience:** Claude / engineering agents / solution architects / implementation team

---

# 0. Purpose

This document is the authoritative architecture baseline for an enterprise-grade, AI-native hotel operations and guest-experience platform.

The product must not be designed as a traditional hotel CRM with an AI chatbot added later. Intelligence is a horizontal platform capability that understands guests, stays, rooms, services, assets, operations, conversations, hotel knowledge, integrations, and management context.

The architecture must support long-term development without requiring a redesign of the core when new hotel modules, PMS systems, AI providers, messaging channels, voice systems, IoT devices, robots, or languages are introduced.

> Complexity belongs in the platform. Simplicity belongs in the user experience.

---


# Product Identity & White-Label Branding

**Product name:** Hotella  
**Product category:** Hotel Intelligence Platform  
**Owned product domain:** `hotella.app`  
**Platform company attribution:** Planova

Hotella is a white-label hotel intelligence platform. The hotel/property brand remains the primary guest-facing identity. Hotella is the B2B product/platform identity used for staff, administration, contracts, implementation and platform operations.

## Branding hierarchy

```text
Platform defaults
 -> Tenant / Hotel Group brand
 -> Property brand
 -> Channel-specific overrides
```

Each property may configure its own guest-facing brand profile, including where applicable:

- hotel/property display name
- logo and alternate logo variants
- primary/secondary brand colors
- guest-facing imagery / cover assets
- favicon/app icons
- typography configuration from approved fonts
- contact information
- social links
- welcome/farewell wording
- AI tone/persona configuration within platform policy
- channel-specific presentation settings

No hotel logo, color, name, guest-facing identity or AI persona may be hardcoded in the application. Branding must resolve dynamically from tenant/property/channel context.

## Guest channels

The same property identity must be consistently resolved across:

```text
Guest Web / PWA
Room QR activation pages
Guest service/request experience
WhatsApp conversation context
Future native mobile app
Voice AI
Email / supported messaging channels
```

External channels such as WhatsApp may have provider-controlled profile elements. Those elements are configured through the relevant provider account/integration and must be associated with the correct property/channel configuration.

## Platform attribution

Guest-facing web/application experiences must include a small, unobtrusive footer attribution by default:

```text
Powered by Planova
```

`Planova` must link to `https://planova.com.eg`. The attribution must support both LTR and RTL layouts and remain visually subordinate to the hotel's own branding.

The platform must preserve this attribution policy independently from property branding configuration unless a future commercial/legal entitlement explicitly defines an approved exception.

---

# 1. Product Vision

The platform must:

- Support single hotels and multi-property hotel groups from one codebase.
- Be multi-tenant and multi-property by design.
- Be modular and licensed by module, capability, property, limits, and usage.
- Be AI-native across guest experience, staff operations, engineering, housekeeping, management, communications, analytics, and integrations.
- Keep hotel employee workflows extremely simple.
- Support OPERA 5.x On-Premise as a first-class integration target without making OPERA the internal domain model.
- Require no modification to OPERA for the guest activation / QR / OTP architecture.
- Treat WhatsApp as a communications channel, not as the conversation system.
- Support future Voice AI, PBX, Messenger, Instagram, mobile applications, smart rooms, BMS, IoT, robots, ERP, POS, door locks, Wi-Fi and new PMS providers.
- Remain independent from any single AI provider.
- Preserve tenant isolation, auditability, explainability, privacy and human control.
- Support Arabic and English from day one.
- Allow future languages without database-schema or business-logic redesign.

---

# 2. Technology Foundation

## 2.1 Backend

Primary backend:

- TypeScript
- NestJS
- Modular monolith initially
- Explicit bounded contexts
- Strong application/domain boundaries
- REST APIs initially with versioning
- Asynchronous events for cross-domain workflows
- OpenAPI contracts for external APIs

Do not begin with dozens of microservices. Preserve domain ownership and event contracts so selected services can be extracted later if scale or isolation requires it.

## 2.2 Database

Primary transactional database:

- PostgreSQL

Use PostgreSQL for:

- Tenant/property configuration
- Identity and permissions
- Guests and stays
- Operational workflows
- Housekeeping
- Engineering/CMMS
- Inspections
- Guest relations
- Communications metadata
- Licensing
- AI execution metadata
- Integration state
- Audit metadata

Rules:

- UUIDv7 identifiers generated by the application.
- `TIMESTAMPTZ` stored in UTC.
- Explicit `tenant_id` on tenant-owned operational tables.
- `property_id` where property scope applies.
- Strong foreign keys for business-critical relationships.
- JSONB only when genuine schema flexibility is needed.
- Optimistic locking/version fields on concurrency-sensitive entities.
- PostgreSQL Row Level Security may be used as defense-in-depth, but never replaces application authorization.

## 2.3 Redis

Use Redis for:

- Caching
- Rate limiting
- Distributed coordination
- Ephemeral session/context state
- Queue infrastructure where appropriate
- Entitlement/configuration caches

## 2.4 Object Storage

Use S3-compatible storage for:

- Images
- Voice notes
- Documents
- Inspection photos
- Lost & Found photos
- Asset manuals
- Attachments

Do not store large binary objects directly in PostgreSQL.

## 2.5 Semantic Retrieval

Use a vector abstraction for:

- RAG
- Knowledge embeddings
- Selected semantic memories
- Semantic search

Possible implementation: pgvector initially or a dedicated vector database such as Qdrant when justified.

The vector store is never the source of truth.

## 2.6 On-Premise Hotel Agent

Use a .NET local service/agent where local hotel connectivity is required, including:

- OPERA 5.x
- FIAS / IFC-related interfaces
- PBX
- BMS
- local databases where contractually supported
- local legacy systems

The local agent must support durable buffering, retries, signed identity, secure outbound-first connectivity, controlled updates and offline licensing grace periods.

---

# 3. Master Bounded Contexts

```text
HOTEL INTELLIGENCE PLATFORM
|
+-- Organization & Property
+-- Identity & Access
+-- Guest & Stay
+-- Service Catalog
+-- Operations & Workflow
+-- Hotel Operations Modules
|   +-- Housekeeping
|   +-- Engineering / CMMS
|   +-- Inspections
|   +-- Guest Relations / Complaints
|   +-- Lost & Found
|   +-- Logbook / Handover
+-- Communications & Guest Experience
+-- AI Platform
+-- Integration Platform
+-- Knowledge & Content
+-- Licensing & Entitlements
+-- Data / Analytics / Audit
```

Each bounded context owns its data.

No domain may directly mutate another domain's tables.

---

# 4. Organization & Property Domain

## 4.1 Tenant

Top-level SaaS customer boundary.

```text
tenants
- id
- code
- name
- status
- default_locale
- default_timezone
- default_currency
- settings
- created_at
- updated_at
```

## 4.2 Organization

A tenant may contain multiple brands/legal organizations.

```text
organizations
- id
- tenant_id
- parent_id nullable
- code
- name
- legal_name
- type
- status
- settings
- created_at
- updated_at
```

## 4.3 Property

Properties belong to the tenant/organization hierarchy and contain:

- code
- name
- timezone
- currency
- default locale
- enabled languages
- country/address/location
- status
- configuration

## 4.4 Generic Location Tree

Use a generic hierarchical location model:

```text
Property
+-- Main Building
|   +-- Floor 1
|   |   +-- Room 101
|   |   +-- Room 102
|   |   +-- Corridor
|   +-- Floor 2
+-- Restaurant
|   +-- Kitchen
|   +-- Dining Area
+-- Pool
+-- Engineering Plant
```

A room is a specialization of a location, not a disconnected hierarchy.

---

# 5. Identity & Access

Core distinction:

```text
Person != User Account != Guest
```

A `Person` represents human identity/profile information.

A `User` represents an authenticated staff/platform account.

A `Membership` associates a user with tenant/organization/property scope.

Authorization is based on:

```text
User
 -> Membership
 -> Tenant
 -> Property Scope
 -> Role
 -> Permission
```

Permissions must be explicit and granular.

Examples:

```text
task.read
task.assign
task.complete
engineering.work_order.create
engineering.work_order.close
integration.configure
integration.replay
ai.manager.use
```

AI agents must pass through the same authorization/policy layer as human users.

---

# 6. Guest & Stay Domain

Guest identity is separate from PMS identity.

Core concepts:

```text
Guest
Stay
Reservation Reference
Stay Party Member
Room Assignment History
External Reference
Guest Preference
Guest Access Grant
```

A stay must preserve room assignment history rather than overwriting a single room field.

External PMS IDs must never become internal primary identifiers.

Use an external-reference abstraction:

```text
external_references
- internal_entity_type
- internal_entity_id
- integration_instance_id
- external_entity_type
- external_id
```

The PMS may remain source of truth for stay/check-in/check-out state.

---

# 7. Service Catalog

Hotel services must be represented independently from UI forms or channels.

A service definition describes:

- code
- category
- availability
- required information
- SLA policy
- workflow
- department ownership
- eligibility
- guest visibility
- automation policy

Examples:

```text
EXTRA_TOWELS
ROOM_CLEANING
AC_PROBLEM
WIFI_HELP
AIRPORT_TRANSFER
LATE_CHECKOUT_REQUEST
```

Published service definitions should be versioned.

---

# 8. Operations & Workflow Core

This is the reusable operational engine for all hotel modules.

Core concepts:

```text
Work Item
Task
Task Assignment
Workflow Definition
Workflow Version
Workflow Instance
Workflow Transition
SLA Policy
SLA Instance
Escalation
Approval Request
Operational Alert
```

Do not rebuild separate task engines for Housekeeping, Engineering, Guest Relations, etc.

## 8.1 Work Item

A generic operational object linking domain-specific work to common workflow/task/SLA infrastructure.

## 8.2 Tasks

Tasks contain:

- status
- priority
- ownership
- assignment
- due/SLA information
- location
- timestamps
- operational history

Assignment history must be preserved.

## 8.3 SLA

SLA calculation must be deterministic, not delegated to an LLM.

Support:

- response SLA
- resolution SLA
- pause rules
- escalation
- business hours
- property/department/service overrides

## 8.4 Approval Engine

Use a generic approval engine for high-risk actions such as:

- compensation
- refunds
- OOO/OOS
- selected AI actions
- sensitive operational changes

---

# 9. Housekeeping Domain

Important rule:

> Room status is not the same thing as a cleaning job.

Maintain fast room operational projections while preserving job/event history.

Example room operational projection:

```text
room_operational_states
- room_id
- occupancy_state
- housekeeping_state
- front_office_state
- dnd_state
- last_cleaned_at
- last_inspected_at
- updated_at
- version
```

Housekeeping states may include:

```text
DIRTY
CLEANING
CLEAN
INSPECTING
INSPECTED
PICKUP
```

## 9.1 Cleaning Jobs

```text
housekeeping_jobs
- id
- tenant_id
- property_id
- work_item_id
- room_id
- stay_id nullable
- cleaning_type
- credits
- status
- scheduled_for
- started_at
- completed_at
- inspected_at
- created_at
- updated_at
- version
```

Types:

```text
STAYOVER
CHECKOUT
ARRIVAL
DEEP_CLEAN
TURNDOWN
TOUCH_UP
VIP
OTHER
```

## 9.2 Housekeeping Credits

Credits must support configurable rules by cleaning type and room type.

Examples:

```text
Standard Checkout = 1.0
Suite Checkout    = 1.8
Villa Checkout    = 3.0
Stayover          = 0.7
Turndown          = 0.4
```

AI/assignment optimization should balance real workload, location and historical cleaning duration, not simply count rooms.

## 9.3 DND / Make Up Room

Represent service/privacy signals independently:

```text
DND
MAKE_UP_ROOM
PRIVACY
SERVICE_REQUESTED
```

Possible sources:

```text
PMS
BMS
SMART_ROOM
STAFF
GUEST_PORTAL
```

---

# 10. Engineering / CMMS

## 10.1 Asset Registry

```text
assets
- id
- tenant_id
- property_id
- parent_asset_id nullable
- asset_number
- asset_type_id
- asset_model_id nullable
- location_id
- name
- serial_number nullable
- manufacturer nullable
- status
- criticality
- installed_at nullable
- warranty_until nullable
- metadata
- created_at
- updated_at
- version
```

Support asset hierarchy:

```text
AHU-01
+-- Motor
+-- Fan
+-- Belt
+-- Filter
```

## 10.2 Asset Types / Models

Asset types may use controlled flexible schemas for type-specific properties.

Asset models allow reliability analysis across identical equipment.

## 10.3 Asset Documents

Associate manuals, datasheets, warranties, diagrams and photos with assets/models through the Knowledge/File layer.

Engineering AI must be able to retrieve the actual manual relevant to the actual asset.

## 10.4 Work Orders

Work order types:

```text
CORRECTIVE
PREVENTIVE
PREDICTIVE
INSPECTION
EMERGENCY
PROJECT
```

Preserve:

- reported time
- diagnosis
- resolution
- downtime
- asset
- location
- failure taxonomy
- work history

## 10.5 Failure Taxonomy

Separate:

```text
SYMPTOM
FAILURE_MODE
CAUSE
RESOLUTION
```

Example:

```text
NOT_COOLING
COMPRESSOR_NOT_STARTING
CAPACITOR_FAILED
CAPACITOR_REPLACED
```

This structured history is important for reliability intelligence.

## 10.6 Meter Readings

Support:

```text
Generator runtime
Pump cycles
Energy
Temperature
Pressure
```

Sources:

```text
STAFF
IOT
BMS
API
```

## 10.7 Preventive Maintenance

Trigger types:

```text
CALENDAR
METER
CONDITION
```

Examples:

- every 30 days
- every 500 running hours
- condition-based maintenance

PM procedures/checklists must be versioned.

## 10.8 Parts

Maintain operational stock/usage without attempting to become a full ERP.

Future ERP/Materials integrations should be adapters.

## 10.9 Warranty Intelligence

Rules/AI should detect when an asset remains under warranty and recommend vendor escalation according to policy.

## 10.10 Room Restrictions

Support:

```text
OOO
OOS
BLOCKED_OPERATIONALLY
```

If the PMS is source of truth for a restriction, synchronization must occur through the integration layer according to capability and policy.

---

# 11. Generic Inspection Engine

One inspection engine must serve:

- room cleanliness
- kitchen hygiene
- pool safety
- fire equipment
- generators
- preventive room checks
- HSE
- security patrols

Core:

```text
inspection_templates
inspection_versions
inspection_sections
inspection_items
inspections
inspection_responses
inspection_findings
```

Item types may include:

```text
PASS_FAIL
YES_NO
SCORE
NUMBER
TEXT
PHOTO
MULTI_SELECT
```

Finding severity:

```text
INFO
MINOR
MAJOR
CRITICAL
```

Critical findings may automatically create urgent work through deterministic rules/workflows.

---

# 12. Guest Relations / Complaints

Complaint is not the same as a service request.

```text
complaints
- id
- tenant_id
- property_id
- complaint_number
- guest_id
- stay_id
- category_id
- severity
- status
- source
- summary
- description
- detected_sentiment nullable
- opened_at
- resolved_at nullable
- closed_at nullable
- created_at
- updated_at
- version
```

Complaints may relate to rooms, requests, tasks, employee interactions, F&B orders or assets.

AI may create a `ComplaintCandidate` based on evidence and confidence.

Do not treat every negative sentence as a complaint automatically.

Preserve complaint evidence and the reason AI classified/escalated it.

Service recovery may include:

```text
APOLOGY
AMENITY
MEAL
DISCOUNT
REFUND
ROOM_MOVE
OTHER
```

High-risk/financial recovery actions use approval policies.

---

# 13. Lost & Found

Core records:

```text
lost_found_items
lost_found_match_candidates
lost_found_claims
```

AI vision may derive metadata such as object type, color or possible brand, but must not overwrite the original staff description.

AI may suggest Lost-to-Found matches with score and reasons. Staff confirms the match.

Claims/releases must be audited.

---

# 14. Logbook & Shift Handover

Maintain operational logbook entries by property/department/shift.

AI may create a concise shift summary from:

- open tasks
- SLA risks
- complaints
- OOO rooms
- work orders
- logbook entries

Human supervisors review/acknowledge handovers.

---

# 15. Operational Alerts

An alert is different from a notification.

Alerts represent conditions needing attention:

```text
Repeated AC failure
SLA breach
Abnormal asset reading
VIP unresolved complaint
Arrival room not ready
```

Notifications are delivery mechanisms for those alerts.

Alert deduplication is required.

---

# 16. Smart Room Readiness

Do not represent readiness as a simplistic boolean.

Derive readiness from configurable dimensions such as:

```text
Housekeeping     PASS
Inspection       PASS
Engineering      PASS
Amenities        PASS
Minibar          PASS
No OOO           PASS
```

Requirements are configurable by property.

---

# 17. Arrival Risk Intelligence

AI/rules may combine:

- arrival ETA
- housekeeping
- inspection
- engineering tasks
- recurring room failures
- VIP status

to produce evidence-backed arrival-risk alerts.

Example:

```text
Room 504
Guest ETA: 28 minutes
AC issue unresolved
Previous related failure yesterday
```

---

# 18. Communications & Guest Experience

## 18.1 Core Principle

WhatsApp is only a channel.

```text
Guest
 |
 +-- WhatsApp
 +-- Guest Web
 +-- Room QR
 +-- Future App
 +-- Voice
 +-- Messenger
 +-- Instagram
 |
 v
Channel Adapters
 |
 v
Conversation Engine
 |
 v
AI Platform
 |
 v
Operations Core
```

## 18.2 Conversations

A conversation is a platform business concept independent of channel/provider.

Participants may be:

```text
GUEST
STAFF
AI
SYSTEM
EXTERNAL
```

Messages may be:

```text
TEXT
IMAGE
AUDIO
VIDEO
DOCUMENT
LOCATION
INTERACTIVE
SYSTEM
```

Delivery events should preserve lifecycle such as:

```text
QUEUED
SENT
DELIVERED
READ
FAILED
```

## 18.3 Channel Identities

Channel identities map identifiers such as a WhatsApp number to a guest identity.

However:

> Phone identity is not authorization.

Access to a room/stay requires a valid Guest Access Grant.

---

# 19. Guest Activation

## 19.1 Primary Activation Flow

On PMS check-in:

```text
PMS
 -> normalized GuestCheckedIn event
 -> Stay becomes IN_HOUSE
 -> Guest Experience Engine
 -> secure activation token
 -> activation URL
```

The activation token and URL are generated by our platform, not OPERA.

Guest UX:

```text
Welcome
Enter mobile number
[ Continue ]
```

No username/password creation is required.

## 19.2 WhatsApp OTP

After mobile entry:

```text
Activation Token
+ Stay
+ Phone
 -> Verification Session
 -> WhatsApp OTP
 -> Verified Identity
 -> Guest Access Grant
```

OTP requirements:

- hashed at rest
- short expiry
- attempt limit
- rate limit
- replay protection

## 19.3 Guest Access Grant

A grant associates:

```text
Guest
Stay
Allowed scopes
Validity period
```

After successful activation, the system should not repeatedly ask the guest for room number/name.

---

# 20. Room QR Fallback

Room QR is generated and managed by our platform.

It must not contain guest data or a guest-specific stay identifier.

The QR resolves to a platform-controlled room/location identity.

Fallback flow:

```text
Static Room QR
 -> Platform resolves Room 504
 -> Room + Last Name verification
 -> Current PMS stay match
 -> Enter mobile number
 -> WhatsApp OTP
 -> Guest identity
 -> Guest Access Grant
```

The QR may be rotated/revoked without changing OPERA.

No OPERA UI/database modification is required for this architecture.

---

# 21. Guest Sessions & Access

Use passwordless guest sessions.

Support multiple devices.

Guest access scopes may include:

```text
SERVICE_REQUEST
CHAT
DINING
CONCIERGE
ROOM_CONTROL
VIEW_BILL
PAYMENT
```

Accompanying guests may receive narrower permissions than the primary guest.

At checkout, room-specific privileges expire/revoke, while selected post-stay capabilities may remain temporarily available:

```text
Lost & Found
Feedback
Invoice Request
General Support
```

---

# 22. Pre-Arrival

Expected stays may access selected capabilities before check-in:

- airport transfer
- special requests
- arrival time
- pillow preferences
- spa/restaurant requests

Room-specific controls activate only according to policy/check-in state.

---

# 23. AI-First Guest UX

Guests should be able to use natural language rather than navigate large forms.

Example:

```text
"الجو حر أوي هنا"
```

AI may resolve:

```text
Guest -> Stay -> Room 504
Intent -> AC problem
Check existing requests
Avoid duplicate
Create/relate request
Route to Engineering
Respond in Arabic
```

Forms remain available where structured fields are necessary, but AI should conversationally collect missing information.

---

# 24. Human Handoff & Unified Inbox

AI must know when to hand off.

Reasons include:

```text
GUEST_REQUESTED_HUMAN
LOW_CONFIDENCE
COMPLAINT
SENSITIVE_REQUEST
PAYMENT_ISSUE
POLICY_REQUIRED
AI_FAILURE
```

Staff should receive a unified contextual inbox showing:

- guest/stay/room
- conversation
- AI summary
- open requests/tasks
- relevant SLA/complaint context

AI may draft replies. Human edits/sends are recorded for learning/evaluation.

---

# 25. Notifications

Separate notification intent from delivery channel.

Possible delivery channels:

```text
Push
WhatsApp
Email
SMS
In-app
```

Notification preferences must be configurable, while critical operational policy may override normal preferences.

---

# 26. Consent & Privacy

Operational/service communication must be separate from marketing consent.

Possible consent types:

```text
SERVICE_COMMUNICATION
MARKETING_WHATSAPP
MARKETING_EMAIL
PERSONALIZATION
```

Using the guest portal does not automatically equal marketing consent.

---

# 27. AI Platform - Core Architecture

```text
Guest AI / Staff AI / Manager AI
             |
             v
        Agent Runtime
             |
   +---------+---------+
   |         |         |
 Context   Memory    Planner
   |         |         |
   +---------+---------+
             |
        Policy Engine
             |
        Tool Registry
             |
     Domain/Application APIs
             |
        Model Gateway
   +---------+---------+
   |         |         |
 OpenAI   Anthropic  Google
   |
 Other / Local Models
```

The AI layer must be provider-independent.

---

# 28. Model Gateway

All model calls pass through one abstraction.

Do not call provider SDKs directly from hotel modules.

The gateway manages:

- provider
- model
- capability
- routing
- fallback
- cost
- latency
- policy
- provider availability

Agents request capabilities, not hardcoded model names.

Example capabilities:

```text
REASONING_HIGH
FAST_CLASSIFICATION
VISION
TRANSLATION
EMBEDDING
AUDIO
STRUCTURED_OUTPUT
```

---

# 29. AI Agents

Initial logical agents may include:

```text
GUEST_CONCIERGE
STAFF_COPILOT
HOUSEKEEPING_COPILOT
ENGINEERING_COPILOT
GUEST_RELATIONS_COPILOT
DUTY_MANAGER
GM_INTELLIGENCE
```

An agent is not just a prompt.

```text
Agent =
Prompt
+ Tools
+ Context Policy
+ Memory Policy
+ Model Routing
+ Autonomy Policy
+ Output Contract
```

Agent versions must be immutable once published.

---

# 30. Prompt Registry

Prompts are versioned.

Prompt composition should use layers:

```text
Platform Instructions
+ Agent Instructions
+ Tenant Policy
+ Property Context
+ Actor Role
+ Current Task
```

Avoid giant monolithic prompts containing unnecessary context.

---

# 31. AI Tool Registry

AI never directly writes business tables.

Tools are registered with:

- code
- domain
- description
- input schema
- output schema
- risk level
- required permission
- status

Examples:

```text
guest.get_current_stay
operations.find_open_requests
operations.create_service_request
task.escalate
maintenance.get_asset
maintenance.create_work_order
knowledge.search
communication.send_message
```

Tool execution still passes through:

```text
Validation
Authorization
Entitlement
Workflow
SLA
Audit
Events
```

---

# 32. AI Risk & Autonomy

Tool risk levels:

```text
READ
LOW
MEDIUM
HIGH
CRITICAL
```

Example policy:

```text
READ     -> AUTO
LOW      -> AUTO
MEDIUM   -> AUTO under conditions
HIGH     -> HUMAN APPROVAL
CRITICAL -> AI cannot execute
```

Actual decision depends on:

```text
Agent
Tool
Risk
Actor
Property policy
Context
```

Do not rely solely on a numeric autonomy level.

---

# 33. AI Action Proposals

High-risk proposed actions become explicit proposals containing:

- proposed tool/action
- arguments
- reason
- evidence
- risk
- expiry
- status

Use the generic Approval Engine for human approval.

---

# 34. AI Execution Audit

Every significant AI execution records:

- tenant/property
- agent/version
- trigger
- actor
- conversation/reference
- execution status
- model calls
- tool calls
- retrieval
- policy decisions
- approvals
- latency
- token usage
- estimated cost
- correlation ID

Execution step types may include:

```text
CONTEXT
MODEL_CALL
TOOL_CALL
RETRIEVAL
DECISION
APPROVAL
RESPONSE
```

---

# 35. Context Engine

Agents do not independently scrape arbitrary data.

They request context through a controlled Context Engine.

Context policies define which information an agent may receive.

Example Guest Concierge context:

```text
Current Guest
Current Stay
Current Room
Available Services
Open Guest Requests
Conversation
Guest-safe Hotel Knowledge
```

Engineering context may include:

```text
Asset
Asset Model
Location
Failure
Work Order
Failure History
PM History
Manual
Relevant Meter Readings
Parts
```

Use minimum necessary data.

---

# 36. AI Memory

Separate short-term conversation state from durable memory.

Long-term memory types may include:

```text
EXPLICIT_PREFERENCE
INFERRED_PREFERENCE
OPERATIONAL_FACT
CONVERSATION_FACT
LEARNED_PATTERN
```

Not every statement becomes permanent memory.

Use candidate -> memory policy -> accept/reject/expire.

Stay-specific operational facts should not silently become permanent guest preferences.

---

# 37. Knowledge / RAG

Knowledge sources may include:

- SOPs
- hotel information
- menus
- policies
- engineering manuals
- brand standards
- emergency procedures
- training content

Knowledge items are scoped by:

- tenant
- property
- department
- language
- audience
- effective dates
- security classification

Use hybrid retrieval:

```text
Metadata filters
+ Keyword search
+ Vector similarity
+ Reranking
```

Structured live data must be accessed through domain tools, not RAG.

Example:

```text
"How many open tasks?"
```

must use an operational query tool, not vector search.

---

# 38. AI Evidence & Explainability

Important recommendations/insights should include:

- reason
- evidence
- confidence
- affected entities
- suggested action

Example:

```text
Recurring AC failure
4 similar failures in 30 days
3 closed as "filter cleaned"
Recommend deeper diagnosis
```

AI retrieval references should be traceable to source/document versions.

---

# 39. AI Triggering

AI may be:

- user-triggered
- event-triggered

Do not run an expensive LLM for every system event.

Use deterministic rules/statistics/anomaly detection first where appropriate, then invoke AI only when semantic reasoning adds value.

---

# 40. AI Evaluation & Learning

Maintain:

```text
ai_feedback
ai_evaluation_sets
ai_evaluation_cases
ai_evaluation_runs
ai_evaluation_results
```

Feedback may be explicit or implicit.

Implicit signals include:

- human reassignment after AI assignment
- heavy edits to AI draft
- guest correcting an AI-created request
- recommendation acceptance/rejection

Before publishing new prompt/agent versions:

- run regression evaluation
- support shadow mode
- support canary rollout

---

# 41. AI Cost & Observability

Track:

- provider
- model
- input/output/cached tokens
- latency
- cost
- tenant
- property
- agent
- capability
- fallback rate
- tool failures
- human override rate

Quality metrics matter more than token count alone.

Examples:

```text
Task creation accuracy
Duplicate avoidance
Correct routing
Resolution rate
Human override rate
Guest re-contact rate
Reopened tasks
AI draft edit distance
Recommendation acceptance
```

---

# 42. AI Safety Rules

Before a tool executes:

```text
AI Proposal
 -> Permission
 -> Entitlement
 -> AI Policy
 -> Risk
 -> Context Conditions
 -> Approval if needed
 -> Execute
```

Retrieved documents are untrusted data, not instructions.

Tool arguments must pass:

```text
Schema Validation
 -> Business Validation
 -> Authorization
 -> Execution
```

Data sent to AI providers must pass classification/redaction/provider policy.

Provide kill switches for:

- provider
- model
- agent
- tool
- auto-actions
- guest AI

---

# 43. Controlled Agent Collaboration

Future specialist agents may delegate in a controlled way.

Example:

```text
Guest Concierge
 -> Engineering Capability
 -> Engineering Agent
 -> Structured Result
 -> Guest Concierge
```

Do not build uncontrolled agent swarms.

---

# 44. Future AI Channels

Voice:

```text
Phone
 -> PBX/Gateway
 -> Voice Channel
 -> Conversation Engine
 -> AI Runtime
 -> Same Tools
```

Vision:

```text
Guest photo
 -> Vision capability
 -> Room/stay context
 -> Existing request check
 -> Operational action
```

IoT:

```text
Sensor
 -> Telemetry
 -> Rules/Anomaly Detection
 -> Meaningful Event
 -> AI when useful
```

Robots may later become operational actors/capabilities without redesigning the task engine.

---

# 45. Integration Platform

Core rule:

> Core domains understand canonical hotel concepts, not OPERA/FIAS/vendor-specific formats.

```text
OPERA 5
OPERA Cloud
Other PMS
POS
ERP
BMS
PBX
IoT
Wi-Fi
 |
 v
Connector Adapters
 |
 v
Integration Platform
 |
 v
Normalized Events / Commands
 |
 v
Core Domains
```

---

# 46. Connector Model

A connector definition describes a provider/type.

An integration instance represents the actual property/customer connection.

Categories may include:

```text
PMS
POS
ERP
BMS
PBX
LOCK
PAYMENT
CRM
IOT
WIFI
OTHER
```

Capabilities may include:

```text
RESERVATION_READ
GUEST_READ
CHECKIN_EVENT
CHECKOUT_EVENT
ROOM_MOVE_EVENT
ROOM_STATUS_READ
ROOM_STATUS_WRITE
OOO_READ
OOO_WRITE
```

Never assume all PMS providers/instances support identical functionality.

---

# 47. Capability Negotiation

The connector type may support a capability while a particular hotel instance does not.

The platform must resolve actual instance capability dynamically.

AI and UI must not offer actions that the active integration cannot perform.

---

# 48. OPERA 5 On-Premise Architecture

```text
Cloud Platform
      |
 Secure outbound connection
      |
Hotel Connector Agent (.NET)
      |
+-----+-------+
|             |
FIAS/IFC   supported local interfaces
      |
   OPERA 5
```

Prefer outbound HTTPS/WSS from the hotel network.

Do not expose a generic remote shell.

Cloud commands must map to predefined signed/authenticated connector operations.

---

# 49. Hotel Agent

The local agent is responsible for:

- connectivity
- authentication
- local adapters
- durable buffering
- retry
- health
- configuration
- certificate management
- updates
- offline operation
- logs

Use a small durable local store such as SQLite for:

- pending events
- acknowledgements
- sync checkpoints
- configuration cache
- license token
- health state

It is not a full copy of the cloud database.

---

# 50. Integration Reliability

Use:

- inbox/outbox patterns
- idempotency
- source message IDs
- ordering metadata
- retries/backoff
- dead-letter queues
- replay safety
- reconciliation
- sync checkpoints

Raw integration messages are not domain events.

Flow:

```text
Raw Vendor Message
 -> Integration Message
 -> Parser
 -> Mapper
 -> Canonical Event
 -> Domain
```

---

# 51. Canonical Events

Examples:

```text
hotel.guest.checked_in.v1
hotel.guest.checked_out.v1
hotel.stay.room_changed.v1
hotel.reservation.updated.v1
hotel.room.status_changed.v1
```

Event envelope:

```text
event_id
event_type
event_version
tenant_id
property_id
source
source_reference
occurred_at
received_at
correlation_id
payload
```

Material schema changes require a new event version.

---

# 52. Mapping & Reconciliation

Integration mappings translate external codes to canonical values.

Unknown mappings create an integration exception rather than guessing.

AI may suggest a mapping, but human confirmation is required where appropriate.

Periodic reconciliation must detect:

```text
MATCH
MISSING_INTERNAL
MISSING_EXTERNAL
DIFFERENT
```

Source-of-truth policies determine conflict resolution.

Do not use naive last-write-wins for all business data.

---

# 53. Integration Commands

Outbound actions use durable commands with:

- command type
- payload
- idempotency key
- lifecycle/status
- acknowledgement
- errors

AI never calls a PMS connector directly.

Example:

```text
AI
 -> Domain Tool
 -> Business Policy
 -> Approval
 -> Room Restriction Domain
 -> Integration Command
 -> PMS Connector
```

---

# 54. OPERA Independence

Guest activation, QR, OTP, guest identity and access grants are platform-owned.

OPERA provides stay/check-in/room context through integration.

No OPERA UI or database schema modification is required for this design.

---

# 55. Other Integration Categories

POS capabilities may include:

```text
MENU_READ
ITEM_AVAILABILITY
ORDER_CREATE
ORDER_STATUS
POST_CHARGE
CHECK_READ
```

ERP:

```text
ITEM_READ
STOCK_READ
REQUISITION_CREATE
PO_STATUS_READ
```

BMS/IoT telemetry should use a dedicated high-volume telemetry path and only emit meaningful operational events after rules/anomaly detection.

PBX/Voice may support:

```text
CALL_RECEIVED
CALL_TRANSFER
CALL_HOLD
CALL_END
EXTENSION_DIRECTORY
```

Wi-Fi may support:

```text
WIFI_SESSION_CREATE
WIFI_SESSION_REVOKE
DEVICE_READ
```

---

# 56. Connector SDK

A connector contract/SDK should define:

- manifest
- capabilities
- configuration schema
- credential schema
- health check
- inbound event mappers
- outbound commands

New connectors must not require core-domain changes.

Support connector simulators and contract tests for development/QA.

---

# 57. Integration Health

Expose simple operational health:

```text
HEALTHY
DEGRADED
OFFLINE
MISCONFIGURED
AUTH_FAILED
```

Track:

- last success
- last failure
- latency
- queue depth
- error rate
- local agent last seen

Use deduplicated alerts.

---

# 58. Licensing & Entitlements

Do not hardcode commercial plans in business logic.

Wrong:

```text
if plan == ENTERPRISE
```

Correct:

```text
EntitlementEngine.can(tenant, property, capability)
```

Core commercial concepts:

```text
Product
Module
Feature
Plan
Plan Version
Subscription
Entitlement
Usage Metric
Usage Event
Usage Aggregate
```

Billing and entitlement are separate concerns.

---

# 59. Module Licensing

Possible modules:

```text
CORE
GUEST_EXPERIENCE
HOUSEKEEPING
ENGINEERING
INSPECTIONS
GUEST_RELATIONS
LOST_FOUND
AI_PRO
AI_INTELLIGENCE
VOICE_AI
```

Possible AI entitlements:

```text
AI_CORE
AI_GUEST
AI_STAFF
AI_HOUSEKEEPING
AI_ENGINEERING
AI_MANAGER
AI_VISION
AI_VOICE
AI_PREDICTIVE
```

Possible connector entitlements:

```text
CONNECTOR_PMS
CONNECTOR_OPERA5
CONNECTOR_OPERA_CLOUD
CONNECTOR_POS
CONNECTOR_BMS
CONNECTOR_PBX
CONNECTOR_ERP
CONNECTOR_WIFI
```

Tenant-wide and property-specific grants must be supported.

---

# 60. Entitlement vs Other Concepts

Keep these separate:

```text
Entitlement:
Did the customer purchase/get the capability?

Feature Flag:
Are we enabling a particular implementation/release?

Configuration:
How should the feature behave at this property?

Permission:
May this actor perform the action?

Connector Capability:
Can the external system perform it?

AI Policy:
May AI autonomously perform it?
```

Unified action gate:

```text
Action Request
 -> Authorization
 -> Entitlement
 -> Feature Availability
 -> Configuration
 -> Connector Capability if relevant
 -> AI Policy if relevant
 -> Execute
```

---

# 61. Usage Metering

Possible metrics:

```text
AI_INPUT_TOKENS
AI_OUTPUT_TOKENS
AI_VISION
VOICE_MINUTES
WHATSAPP_CONVERSATIONS
STORAGE_BYTES
ACTIVE_STAFF
ACTIVE_PROPERTIES
API_CALLS
```

Usage events must be idempotent and aggregated for efficient reporting/billing.

---

# 62. Offline Connector Licensing

Cloud may issue signed license tokens containing:

- tenant
- property
- connector
- capabilities
- issue/expiry
- offline grace

The hotel agent validates tokens cryptographically with a public key.

Temporary internet loss must not immediately stop critical hotel integration operations.

---

# 63. SaaS Control Plane

Logical control plane:

```text
Tenant Management
Subscriptions
Entitlements
Feature Flags
Connector Registry
AI Provider Registry
Platform Configuration
Support
Deployment Management
System Health
```

Operational hotel data belongs to the data plane.

Platform administrators must not automatically have unrestricted access to guest data.

---

# 64. Support Access

Support access should be:

- explicit
- scoped
- time-limited
- read-only by default
- audited
- reason-based
- revocable

Avoid permanent "God Mode".

---

# 65. Security Architecture

Security covers:

- identity
- tenant isolation
- application authorization
- integrations
- AI
- data
- infrastructure
- audit

Staff authentication should support strong password/MFA initially and future OIDC/SAML/enterprise SSO.

Guest authentication is passwordless.

---

# 66. Session & Token Security

Staff:

```text
Short-lived access token
+ rotating refresh token
+ session/device revocation
```

Guest activation tokens:

- high entropy
- single-purpose
- expiring
- revocable
- stored hashed

OTP:

- hashed
- short-lived
- attempt-limited
- rate-limited

---

# 67. Data Protection

Use:

- TLS in transit
- encrypted database/storage/backups
- field-level encryption where justified
- secret manager/vault for production credentials

Do not store permanent production secrets in ordinary application configuration.

Data classifications:

```text
PUBLIC
INTERNAL
CONFIDENTIAL
SENSITIVE
RESTRICTED
```

AI context must respect classification and provider policy.

---

# 68. Audit

Audit actors may be:

```text
USER
GUEST
AI_AGENT
SYSTEM
INTEGRATION
SUPPORT
```

For important actions, the system must answer:

```text
Who initiated it?
Who approved it?
What policy allowed it?
What changed?
Which integration acknowledged it?
Which AI/model/tool was involved?
```

Critical audit data should be append-oriented and tamper-resistant.

---

# 69. Privacy & Retention

Support:

- consent history
- data export
- correction
- retention
- anonymization
- deletion where legally/operationally allowed

Do not destroy required operational/audit integrity simply to delete a guest profile; anonymization may be more appropriate.

Retention policies should be configurable by data class/tenant/region.

---

# 70. Observability

Use:

```text
Logs
Metrics
Traces
```

Correlate flows using:

```text
correlation_id
trace_id
tenant_id
property_id
```

Avoid sensitive data leakage into logs.

Example trace:

```text
WhatsApp webhook
 -> Conversation
 -> AI execution
 -> Tool call
 -> Service request
 -> Workflow
 -> Task
 -> Notification
```

---

# 71. Deployment

Initial logical deployment may include:

```text
platform-api
platform-worker
platform-scheduler
realtime-gateway
integration-worker
ai-worker
```

Worker pools should be isolated by workload.

Suggested queue priorities:

```text
CRITICAL_OPERATIONAL
GUEST_REALTIME
NORMAL
ANALYTICS
BACKGROUND_AI
```

Guest real-time workloads must not wait behind large analytics/background queues.

Applications should be stateless where practical and horizontally scalable.

---

# 72. Database / Resilience

Production should support:

- PostgreSQL backups
- point-in-time recovery
- replicas where justified
- restore testing
- defined RPO/RTO
- disaster-recovery procedures

Database migrations should follow expand/deploy/migrate/contract patterns for zero/minimal downtime.

---

# 73. Configuration & Feature Flags

Configuration inheritance:

```text
Platform Default
 -> Tenant
 -> Property
 -> Department / Module
```

Critical configuration changes must be audited/versioned.

Feature flags are for:

- beta releases
- canaries
- experiments
- emergency disable

Feature flags are not licensing.

---

# 74. API Architecture

External APIs should be versioned:

```text
/api/v1/...
```

Create operations that may be retried should support idempotency keys.

Outbound webhooks require:

- signing
- retries
- exponential backoff
- dead-letter handling
- replay

Rate limiting may apply by IP, guest, user, tenant, API client and endpoint.

---

# 75. Developer & Extension Platform

Future platform capabilities may include:

- developer apps
- OAuth clients
- API keys/scopes
- webhooks
- Connector SDK
- AI Tool SDK
- Module manifests

Do not initially allow arbitrary untrusted code plugins inside the production runtime.

Prefer contract-based extension points.

---

# 76. Module Manifest Concept

A future module may declare:

```text
module: SPA

features:
- SPA_BOOKING
- SPA_AVAILABILITY

permissions:
- spa.read
- spa.book

ai_tools:
- spa.search_availability
- spa.create_booking

events:
- spa.booking.created
```

This allows new modules to join the platform consistently.

---

# 77. Repository Structure

Suggested logical repository structure:

```text
/apps
  /api
  /worker
  /realtime
  /hotel-agent

/packages
  /domain
    /organization
    /identity
    /guest
    /operations
    /housekeeping
    /engineering
    /communications
    /ai
    /integrations
    /licensing

  /platform
    /database
    /events
    /queue
    /auth
    /observability
    /storage
    /config

  /contracts
    /events
    /api
    /connectors
    /ai-tools
```

Do not turn `/domain` into an unstructured giant shared package.

Each bounded context remains owner of its data and application logic.

---

# 78. PostgreSQL Schema Ownership

Suggested logical schemas:

```text
org.*
iam.*
guest.*
ops.*
hk.*
eng.*
inspection.*
relations.*
comms.*
ai.*
integration.*
license.*
audit.*
```

The exact physical schema strategy may be adjusted during implementation, but ownership boundaries must remain clear.

---

# 79. Internationalization & Localization

This is a mandatory architecture rule.

The platform is bilingual from day one:

```text
English (en) - primary
Arabic  (ar) - first-class RTL
```

The architecture must allow future languages without database schema redesign.

## 79.1 No Hardcoded User-Facing Strings

No user-facing UI text may be hardcoded in application code.

Use external locale resources.

Example:

```text
/locales
  /en
    common.json
    navigation.json
    guest.json
    housekeeping.json
    engineering.json
    errors.json

  /ar
    common.json
    navigation.json
    guest.json
    housekeeping.json
    engineering.json
    errors.json
```

Use stable keys:

```text
guest.request.created
housekeeping.room.ready
engineering.work_order.closed
```

## 79.2 Do Not Use Language-Specific Columns

Forbidden default design:

```text
name_en
name_ar
description_en
description_ar
```

Also do not default to embedded language objects in every business row.

For dynamic business content requiring localization, use normalized translation entities/tables.

Example:

```text
services
- id
- code
- category_id
...

service_translations
- service_id
- locale
- name
- description
```

The same pattern may be used where needed for categories, menus, locations, knowledge content, etc.

Not every table needs a translation table; only user-facing data that genuinely requires localization.

## 79.3 Locale Resolution

Possible resolution order:

```text
Explicit user choice
 -> Guest/User preference
 -> Detected conversation language
 -> Property default
 -> Platform default (en)
```

## 79.4 RTL

Arabic support includes true RTL layout behavior across:

- navigation
- forms
- tables
- dialogs
- dates/numbers where appropriate
- notifications
- guest portal
- staff portal
- administration

Arabic is not merely translated English text.

## 79.5 AI Language Behavior

AI must detect and naturally respond in the appropriate language.

The knowledge layer must support:

- Arabic documents
- English documents
- cross-language retrieval

Example: an engineer asks in Arabic about an English manual; the AI may retrieve the English manual and answer in Arabic while preserving evidence.

---

# 80. Hotel Operational Digital Twin

Over time, the platform should form an operational digital twin / graph:

```text
Property
+-- Rooms
|   +-- Guests
|   +-- Stays
|   +-- Assets
|   +-- Tasks
|   +-- Incidents
+-- Staff
+-- Departments
+-- Assets
+-- Services
+-- Workflows
+-- Conversations
+-- Inspections
+-- Integrations
```

Example relationship:

```text
Guest
 -> Stay
 -> Room
 -> AC Unit
 -> Failure
 -> Work Order
 -> Engineer
 -> Resolution
 -> Guest Feedback
```

This connected operational context is the foundation of differentiated hotel intelligence.

---

# 81. Intelligence Flywheel

```text
Guest Request
 -> AI Understanding
 -> Operational Action
 -> Staff Action
 -> Resolution
 -> Guest Reaction
 -> Feedback
 -> Evaluation
 -> Better Intelligence
```

The product should learn from operational outcomes without allowing uncontrolled self-modification of production logic.

---

# 82. Non-Negotiable Architecture Invariants

1. Tenant isolation cannot be bypassed.
2. Property authorization must be explicit.
3. AI never bypasses domain permissions or business policies.
4. AI does not directly mutate business database tables.
5. External/provider IDs never become internal identity.
6. Published definitions are versioned.
7. Important operational history is preserved.
8. Integrations are idempotent.
9. High-risk AI actions pass policy/approval gates.
10. Structured live data is accessed through domain tools, not RAG.
11. Knowledge retrieval respects security/scope.
12. WhatsApp is a channel, not the conversation system.
13. OPERA is an integration, not the internal core data model.
14. Guest activation/QR/OTP is platform-owned and requires no OPERA schema/UI modification.
15. Licensing is entitlement-based.
16. Billing, configuration, permissions, feature flags, entitlements and connector capabilities are separate concepts.
17. Provider-specific AI logic remains behind the Model Gateway.
18. Staff UX must remain simpler than backend architecture.
19. English and Arabic are first-class from day one.
20. User-facing UI strings use external locale resources.
21. Dynamic localized business content uses normalized translation entities, not `*_en` / `*_ar` columns.
22. Arabic receives full RTL support.
23. Adding a future language must not require business-logic or core-schema redesign.
24. AI should understand/respond in the appropriate user language automatically.
25. Deterministic security/business calculations stay deterministic; do not delegate them to LLMs.
26. Unknown external integration values must not be guessed.
27. Raw vendor messages are not domain events.
28. Every important AI action is traceable to agent/model/context/tools/policy/approval.
29. Support access is scoped, temporary and audited.
30. Secrets are not stored as ordinary plaintext application configuration.
31. Guest-facing branding resolves dynamically by tenant/property/channel.
32. The hotel/property brand is the primary guest-facing identity.
33. Guest-facing web/application experiences display a small `Powered by Planova` attribution linked to `https://planova.com.eg` by default.
34. Branding and AI persona configuration must never weaken platform safety, authorization, localization or operational policies.

---

# 83. Explicit Anti-Patterns for Claude

Claude must not implement shortcuts such as:

```text
AI writes directly to PostgreSQL business tables.
Guest Portal queries OPERA directly.
Housekeeping sends WhatsApp directly.
Engineering owns duplicate guest profile data.
PMS IDs are used as internal primary keys.
Plan names control features in business code.
Provider-specific model calls are scattered through modules.
Production API keys are stored plaintext.
Every AI call receives all available tenant/guest data.
Every event invokes an LLM.
Every translated entity gets name_en/name_ar columns.
Room QR contains guest PII.
Room QR is regenerated manually for every guest.
High-risk AI actions execute without policy/approval.
Hotel branding is hardcoded into frontend components.
One property can accidentally inherit another property's guest-facing branding.
The `Powered by Planova` attribution is removed by ordinary property branding settings.
Last-write-wins is used for every integration conflict.
```

---

# 84. Implementation Rules for Claude

When implementing from this specification:

1. Treat this document as the architecture source of truth.
2. Do not redesign foundational boundaries without explicitly documenting the reason and impact.
3. Do not build the entire product in one pass.
4. Work phase-by-phase.
5. Before coding a phase, produce:
   - scope
   - domain model
   - migrations
   - APIs
   - events
   - permissions
   - tests
   - acceptance criteria
6. Preserve bounded-context ownership.
7. Prefer application interfaces/domain services over cross-domain table access.
8. Use transactional outbox/inbox patterns for reliable cross-domain/integration events.
9. Use idempotency for retriable external/create operations.
10. Implement authorization and tenant/property scope before exposing features.
11. Build auditability into important mutations from the beginning.
12. Build English/Arabic localization into the first UI components, not as a later migration.
13. Keep AI behind tools/policies from the first AI implementation.
14. Implement deterministic workflows before asking AI to reason over them.
15. Add observability/correlation IDs from the beginning.
16. Never silently weaken a requirement to simplify implementation; surface the tradeoff.
17. Do not introduce a new infrastructure dependency unless the existing stack cannot reasonably satisfy the requirement.
18. Prefer simple, robust implementations that preserve future extensibility over premature distributed complexity.
19. Every new module should define its permissions, events, entitlements, AI tools (if any), localized content strategy and integration dependencies.
20. Maintain architecture decision records (ADRs) for material deviations or technology choices.

---

# 85. Recommended Implementation Roadmap

## Phase 0 - Repository & Engineering Foundation

Deliver:

- monorepo/repository structure
- NestJS foundation
- PostgreSQL
- Redis
- configuration system
- structured logging
- tracing/correlation IDs
- migration framework
- test framework
- CI baseline
- secrets abstraction
- locale framework (`en`, `ar`, RTL)
- event/outbox foundation

No hotel business feature should bypass these foundations.

## Phase 1 - Organization, IAM & Property

Deliver:

- tenant
- organization
- property
- location hierarchy
- staff users
- memberships
- roles/permissions
- sessions
- audit baseline
- property-scoped authorization
- localization preferences
- tenant/property brand profiles and inheritance
- guest-facing branding resolver
- platform attribution policy

Acceptance: one user can have different permissions across different properties without data leakage.

## Phase 2 - Guest, Stay & PMS Canonical Model

Deliver:

- guest
- stay
- stay party
- room assignment history
- external references
- canonical PMS events
- simulator for check-in/check-out/room move

Do not require OPERA to develop/test the core.

## Phase 3 - Operations Engine

Deliver:

- work items
- tasks
- assignment history
- workflows
- SLA
- escalation
- approval engine
- alerts
- notification intent

Acceptance: multiple future modules can create work without creating separate task engines.

## Phase 4 - Communications & Guest Identity

Deliver:

- channel abstraction
- conversations
- messages
- delivery events
- channel identities
- guest activation tokens
- WhatsApp OTP abstraction
- guest access grants
- sessions
- Room QR fallback
- unified staff inbox baseline

Acceptance: a checked-in guest can activate without OPERA modification and later be recognized automatically on the verified channel.

## Phase 5 - Guest Service Catalog

Deliver:

- service definitions/versions
- categories
- localized service content
- service availability
- request creation
- workflow/SLA binding
- guest portal service experience

## Phase 6 - AI Foundation

Deliver:

- model gateway
- provider abstraction
- model routing
- agent/version registry
- prompt registry
- tool registry
- context engine
- policy/autonomy gates
- AI execution audit
- cost/token metrics
- initial Guest Concierge tools

AI must not have direct database write access.

## Phase 7 - Housekeeping

Deliver:

- room operational state projection
- cleaning jobs
- credit rules
- assignments through Operations Core
- DND/MUR signals
- inspection integration
- initial housekeeping AI recommendations

## Phase 8 - Engineering / CMMS

Deliver:

- assets/hierarchy/models
- work orders
- failure taxonomy
- PM
- meters
- parts usage
- warranty
- room restrictions
- engineering knowledge retrieval
- Engineering Copilot

## Phase 9 - Generic Inspections / Guest Relations / Lost & Found

Deliver shared inspection engine first, then complaint/service recovery and Lost & Found with AI-assisted evidence/matching.

## Phase 10 - Real OPERA 5 On-Premise Integration

Deliver:

- .NET hotel agent
- secure registration
- outbound connection
- local durable queue
- FIAS/IFC adapter according to actual available interface
- mapping
- canonical events
- reconciliation
- health
- signed offline license
- controlled update/rollback

Do not tightly couple the core to FIAS.

## Phase 11 - Licensing / Control Plane

Deliver:

- products/modules/features
- plan versions
- subscriptions
- entitlements
- limits
- usage metering
- property-specific licensing
- AI/connector entitlements
- control-plane administration

## Phase 12 - Advanced Intelligence

Deliver:

- manager intelligence
- cross-property analysis
- insight/recommendation engine
- evaluation datasets
- shadow/canary AI versions
- predictive models where data quality supports them
- advanced cost optimization

## Phase 13 - Voice / IoT / Additional Connectors

Add using existing abstractions rather than redesigning the core.

---

# 86. Definition of "Smart"

"Smart" does not mean placing an LLM chat box on every screen.

The system is smart when it:

- understands context automatically
- knows the current guest/stay/room
- avoids duplicate requests
- routes work correctly
- detects operational risk
- correlates failures and complaints
- summarizes what matters
- recommends actions with evidence
- learns from human corrections
- uses deterministic logic where AI is unnecessary
- asks humans only when policy/risk requires them
- speaks the user's language naturally
- minimizes steps for hotel employees and guests

The goal is:

> AI understands the hotel, not merely the user's sentence.

---

# 87. Final Architecture

```text
                         GUESTS
                            |
       WhatsApp / Web / Voice / App / QR
                            |
                            v
                  GUEST EXPERIENCE
                            |
                            v
                    AI EXPERIENCE
                            |
             +--------------+--------------+
             |              |              |
          Context         Memory        Knowledge
             |              |              |
             +--------------+--------------+
                            |
                      AI RUNTIME
                            |
                   Policy / Tool Layer
                            |
                            v
                   OPERATIONS CORE
                            |
       +-----------+--------+--------+-----------+
       |           |                 |           |
 Housekeeping  Engineering     Guest Relations  Inspections
       |           |                 |           |
       +-----------+--------+--------+-----------+
                            |
                            v
                  INTEGRATION PLATFORM
                            |
      +---------+---------+--+---+-------+--------+
      |         |         |      |       |        |
     PMS       POS       ERP    BMS     PBX      IoT
      |
 OPERA 5 / OPERA Cloud / Other PMS
```

Foundation underneath:

```text
IAM / TENANCY / LICENSING / AUDIT / EVENTS
SECURITY / OBSERVABILITY / STORAGE / CONFIG
LOCALIZATION / ENGLISH / ARABIC / RTL
```

Control above:

```text
SAAS CONTROL PLANE
```

---

# 88. End State

The intended product is not:

```text
Hotel Software + Chatbot
```

It is:

```text
HOTEL INTELLIGENCE OPERATING PLATFORM
```

with a connected operational model of the hotel, an AI platform capable of safely reasoning over that model, and modular hotel applications that share the same operational, integration, identity, licensing and intelligence foundations.

This architecture must remain capable of evolving for years without forcing hotels to replace the core as new modules, providers, channels and intelligent capabilities are introduced.

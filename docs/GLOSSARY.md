# Glossary (English / العربية)

Platform terms are defined by the spec; hotel terms follow common Egyptian/Gulf hotel usage. Use the English code in code and both languages in UI catalogs.

## Platform
| Term | العربية | Meaning |
|---|---|---|
| Tenant | عميل المنصة / المجموعة | Top-level SaaS customer boundary (a hotel group or single hotel company). |
| Organization | كيان / علامة | Brand or legal entity inside a tenant. |
| Property | الفندق / المنشأة | A hotel; carries timezone, currency, locales, branding. |
| Location | موقع | Node in the location tree (building, floor, room, area, plant). A room is a location. |
| Person / User / Guest | شخص / مستخدم / نزيل | Three different things: human profile; staff login; hotel guest. |
| Membership | عضوية | Links a user to tenant/property scope and roles. |
| Permission | صلاحية | Granular right such as `task.assign`. |
| Entitlement | استحقاق (ترخيص) | What the customer bought (module/feature/limit). Not a permission, not a flag. |
| Feature flag | مفتاح ميزة | Release control (beta/canary/emergency off). Not licensing. |
| Action Gate | بوابة التنفيذ | Pipeline every mutation passes: authorization → entitlement → feature → configuration → connector capability → AI policy. |
| Work Item / Task | بند عمل / مهمة | Generic operational object and its executable unit, shared by all modules. |
| SLA | اتفاقية مستوى الخدمة | Deterministic response/resolution deadlines with pauses and escalation. |
| Approval Request | طلب موافقة | Human gate for high-risk actions (refunds, OOO, AI proposals). |
| Alert vs Notification | تنبيه / إشعار | Condition needing attention vs the message delivering it. |
| Conversation / Channel | محادثة / قناة | Platform conversation; WhatsApp, web, QR, voice are channels into it. |
| Channel Identity | هوية القناة | A phone/email mapped to a guest. Never authorization by itself. |
| Guest Access Grant | منحة وصول النزيل | Guest + stay + scopes + validity. The actual authorization. |
| Activation Token / OTP | رمز التفعيل / رمز التحقق | Platform-generated activation link; one-time code over WhatsApp/SMS. |
| Room QR | رمز QR للغرفة | Static, platform-owned, no guest data; resolves to a room. |
| Outbox / Inbox | صندوق صادر / وارد | Transactional event publishing / idempotent consumption tables. |
| Canonical Event | حدث قياسي | PMS-neutral event like `hotel.guest.checked_in.v1`. |
| Connector / Integration Instance | موصّل / نسخة تكامل | Adapter type (e.g. OPERA5_FIAS) / the configured link at one property. |
| Capability | قدرة | What a connector instance can actually do (negotiated per instance). |
| Model Gateway | بوابة النماذج | Single abstraction over AI providers; capability-based routing. |
| Tool (AI) | أداة | Registered, schema-validated, permission-checked action an agent may call. |
| Action Proposal | مقترح إجراء | High-risk AI action waiting for human approval. |
| Context Engine | محرك السياق | Controlled supplier of the minimum data an agent may see. |
| Module Manifest | بيان الوحدة | Declaration of a context's permissions, events, entitlements, tools, locales, data classes. |
| Data class | تصنيف البيانات | PUBLIC / INTERNAL / CONFIDENTIAL / SENSITIVE / RESTRICTED on every column. |

## Hotel operations
| Term | العربية | Meaning |
|---|---|---|
| PMS | نظام إدارة الفندق | Property Management System (OPERA 5 here). Source of truth for reservations, check-in/out, rooms. |
| Stay / Reservation | إقامة / حجز | Actual occupancy period / the booking record. |
| In-house | مقيم حالياً | Checked-in guest. |
| Expected / Arrival | متوقع الوصول | Reservation due to check in. |
| ETA | وقت الوصول المتوقع | Expected arrival time. |
| Room move | تغيير غرفة | Guest reassigned to another room during the stay. |
| Stayover | تنظيف إقامة مستمرة | Daily cleaning of an occupied room. |
| Checkout clean | تنظيف مغادرة | Full clean after departure. |
| Turndown | خدمة المساء | Evening room preparation. |
| Deep clean | تنظيف شامل | Periodic intensive cleaning. |
| DND / MUR | عدم الإزعاج / تنظيف الغرفة | Do Not Disturb / Make Up Room signals. |
| Room status | حالة الغرفة | Dirty, Cleaning, Clean, Inspected, Pickup… (housekeeping) and Vacant/Occupied (front office). |
| OOO / OOS | خارج الخدمة / خارج المبيع | Out of Order (not sellable, maintenance) / Out of Service (sellable with limitation). |
| Housekeeping credits | نقاط التنظيف | Workload units per cleaning type/room type. |
| Work order | أمر شغل | Maintenance job (corrective, preventive, predictive, inspection, emergency, project). |
| PM | صيانة وقائية | Preventive maintenance (calendar, meter, condition triggers). |
| Asset | أصل | Equipment item (AHU, chiller, generator) with hierarchy and model. |
| Failure taxonomy | تصنيف الأعطال | Symptom → failure mode → cause → resolution. |
| Meter reading | قراءة عداد | Runtime hours, cycles, energy, temperature, pressure. |
| Inspection / Finding | تفتيش / ملاحظة | Checklist execution / an issue found with severity. |
| Complaint | شكوى | Guest dissatisfaction record; distinct from a service request. |
| Service recovery | معالجة الشكوى | Apology, amenity, meal, discount, refund, room move. |
| Lost & Found | المفقودات | Items found/lost, matching, claims. |
| Logbook / Handover | سجل الورديات / التسليم | Shift notes and shift-change summary. |
| VIP | نزيل مميز | Guest flagged for special handling. |
| Front desk / Front office | الاستقبال | Reception department. |
| Duty manager | مدير المناوبة | Manager responsible during a shift. |
| GM | المدير العام | General Manager. |
| F&B | الأغذية والمشروبات | Food & Beverage. |
| POS | نقاط البيع | Point of sale (restaurants, bars). |
| BMS | نظام إدارة المبنى | Building Management System (HVAC, energy). |
| PBX | السنترال | Telephone exchange. |
| FIAS / IFC8 | واجهة فيديليو / متحكم الواجهات | OPERA's interface protocol / interface controller used for real-time events. |
| OWS | خدمات ويب أوبرا | OPERA Web Services (SOAP) for reservations and profiles. |
| BSP | مزود حلول واتساب | WhatsApp Business Solution Provider (alternative to Meta Cloud API). |

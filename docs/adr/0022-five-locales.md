# ADR-0022: Five user-facing languages — English, Arabic, Italian, Russian, German

**Status:** Accepted — 2026-10-05 (product owner decision: "add Italian, Russian and German to the system")

## Context
Hotella shipped with English and Arabic (Spec §79; CLAUDE.md rule 7: `en`/`ar` key parity, Arabic RTL first-class).
The owner's hotels receive many Italian, Russian and German guests (Red Sea and Nile resorts), so guests and staff must
be able to use those languages too. The i18n foundation was built for this: one ICU MessageFormat catalog shared by
API and web apps, locale resolution (explicit choice → user/guest preference → conversation language → property
default → `en`), business data in `<entity>_translations(entity_id, locale, …)` tables, never per-language columns.

## Decision
- **Supported locales:** `en` (default, source of truth for keys), `ar`, `it`, `ru`, `de`. Arabic stays the only RTL
  locale; the others are LTR. The list lives in configuration (`SUPPORTED_LOCALES`, default `en,ar,it,ru,de`) and in
  one shared constant for the web apps; a property chooses which of them it enables (`enabledLocales`).
- **Parity for every locale:** the catalog check (`pnpm locales:check`) requires every locale to have exactly the keys
  of `en`, valid ICU, the same arguments, and the plural categories that locale needs (CLDR via `Intl.PluralRules`:
  Russian `one/few/many/other`, Arabic `zero/one/two/few/many/other`, Italian/German `one/other`). CLAUDE.md rule 7
  is restated for all supported locales.
- **Business data:** translation tables accept any supported locale (no `en`/`ar`-only constraint); fallback when a
  translation is missing is the property default, then `en` — never an empty label.
- **Guest language from the PMS:** OPERA/FIAS language codes map to these locales through the integration mapping
  (unknown codes create an integration exception, never a guess — rule 16).
- **Channels and AI:** WhatsApp/SMS templates exist per locale (a template missing in a locale falls back as above and
  is reported); the AI concierge answers in the guest's language (Spec §79.5).
- **Translation quality:** the first Italian, Russian and German catalogs are drafted by engineering and must be
  reviewed by a native speaker before the first hotel uses them (an owner item); keys are stable, so review edits are
  text changes only.
- **Dates, numbers, currency:** formatted with `Intl` for the active locale; Russian and German use their own
  separators and date order.

## Consequences
- Adding a language later is a configuration value, a catalog file and its review — no code path names a language.
- Every new key now needs five values; the parity check fails a build that misses one.
- UI is verified LTR in English and RTL in Arabic as before; Playwright adds one smoke per new locale (layout does not
  change, but longer German/Russian words must not overflow).

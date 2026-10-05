# Locale catalog

One ICU MessageFormat catalog shared by the backend (`@hotella/platform-i18n`) and the frontend (`next-intl`).

- Folder per locale (`en`, `ar`, `it`, `ru`, `de` — ADR-0022; Arabic is the only right-to-left one), file per namespace (`common.json`, `errors.json`, later `guest.json`, `housekeeping.json`, …).
- Keys are flat, dot-separated, **global** and stable: `<domain>.<entity>.<message>` (CLAUDE.md rule 24). Files only organize keys; the same key in two files fails the check. Error messages live under `errors.<code>` (e.g. `errors.guest.activation.token_expired`) so the API can look them up by Problem Details code. Never rename a key to change wording.
- The frontend (`next-intl`) unflattens these keys into nested namespaces at load time; the backend reads them flat.
- Messages use ICU: `{count, plural, one {...} other {...}}`, `{name}`, `{amount, number}`, `{at, date, short}`. Each locale offers its own CLDR plural categories: Arabic zero/one/two/few/many/other (`=0` may stand for zero), Russian one/few/many/other, Italian one/many/other, German and English one/other.
- Every locale must have exactly the keys of `en`, with valid ICU, the same arguments and its plural categories; `pnpm locales:check` enforces it in CI. A new key needs all five values. The it/ru/de texts were drafted by engineering and are reviewed by native speakers before a hotel uses them (BUILD_PLAN Q17); a review changes text only, never keys.
- A key referenced in code must exist in `en` (the fallback). Missing keys render as the key itself and are logged once.

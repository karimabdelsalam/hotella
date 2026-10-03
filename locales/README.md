# Locale catalog

One ICU MessageFormat catalog shared by the backend (`@hotella/platform-i18n`) and the frontend (`next-intl`).

- Folder per locale (`en`, `ar`), file per namespace (`common.json`, `errors.json`, later `guest.json`, `housekeeping.json`, …).
- Keys are flat, dot-separated, **global** and stable: `<domain>.<entity>.<message>` (CLAUDE.md rule 24). Files only organize keys; the same key in two files fails the check. Error messages live under `errors.<code>` (e.g. `errors.guest.activation.token_expired`) so the API can look them up by Problem Details code. Never rename a key to change wording.
- The frontend (`next-intl`) unflattens these keys into nested namespaces at load time; the backend reads them flat.
- Messages use ICU: `{count, plural, one {...} other {...}}`, `{name}`, `{amount, number}`, `{at, date, short}`. Arabic uses all six CLDR plural categories (zero/one/two/few/many/other).
- `en` and `ar` must have identical key sets per namespace; `pnpm locales:check` enforces it in CI.
- A key referenced in code must exist in `en` (the fallback). Missing keys render as the key itself and are logged once.

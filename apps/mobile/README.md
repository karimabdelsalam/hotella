# Hotella — the staff app (Flutter)

One app for the staff of every hotel on the platform (ADR-0023): hotel code → the hotel's brand → sign-in with the
person's own account (same IAM, MFA and sessions as the staff web) → the parts of the app their permissions open.
Guests never use it.

- Strings: `/locales/*/mobile.json` → `node tool/sync_arb.mjs` → `lib/l10n/app_*.arb` → `flutter gen-l10n`.
- API client: `apps/api/test/__snapshots__/openapi.json` → `node tool/gen_client.mjs` → `lib/api/hotella_api.g.dart`.
  Both generated files are checked in CI (`--check`); never edit them by hand.
- Platform URL per build: `flutter run --dart-define=HOTELLA_API=https://api.example`.
- Checks: `flutter analyze`, `flutter test` (widget tests against a fake API, en/ar RTL and it/ru/de).

See `docs/DEVELOPER_GUIDE.md` for the toolchain version.

Fixtures for `pnpm lint:selftest`. Negative fixtures must fail the rule named in `tooling/bin/lint-selftest.mjs`; positive
fixtures (listed under `allowed`) must not trip it, so an over-broad rule is caught as well as a missing one.
They are excluded from the normal `pnpm lint` run and linted explicitly by the self-test with layer overrides applied by path.

Negative fixtures for `pnpm lint:selftest`. Each file must fail the rule named in `tooling/bin/lint-selftest.mjs`.
They are excluded from the normal `pnpm lint` run and linted explicitly by the self-test with layer overrides applied by path.

import { defineConfig } from 'vitest/config';
import { defineBaseConfig } from '@hotella/tooling/vitest';

export default defineConfig(
  defineBaseConfig({
    test: {
      globalSetup: ['@hotella/platform-testing/global-setup'],
      testTimeout: 120_000,
      hookTimeout: 180_000,
    },
  }),
);

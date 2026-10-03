import swc from 'unplugin-swc';
import { swcOptions } from './swc.config.mjs';

/** Base Vitest config for every package: SWC transform with decorator metadata, node environment. */
export function defineBaseConfig(overrides = {}) {
  return {
    plugins: [swc.vite({ ...swcOptions, module: { type: 'es6' } })],
    test: {
      environment: 'node',
      include: ['src/**/*.spec.ts', 'test/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
      passWithNoTests: false,
      coverage: { provider: 'v8', reporter: ['text', 'lcov'], reportsDirectory: './coverage' },
      ...(overrides.test ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'test')),
  };
}

/** dependency-cruiser — repo-wide cycle detection and the documentation graph (ADR-0001). */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make bounded contexts inseparable (Spec §3).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'platform-not-to-domain',
      severity: 'error',
      from: { path: '^packages/platform/' },
      to: { path: '^packages/domain/' },
    },
    {
      name: 'contracts-only-contracts',
      severity: 'error',
      from: { path: '^packages/contracts/' },
      to: { path: '^(packages/(platform|domain)|apps)/' },
    },
    {
      name: 'domain-to-domain-only-public',
      severity: 'error',
      comment: 'A bounded context may depend on another only through its public entry point.',
      from: { path: '^packages/domain/([^/]+)/' },
      to: { path: '^packages/domain/(?!$1/)[^/]+/src/(?!public/)' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '(^|/)tsconfig\\.json$',
          '\\.spec\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    exclude: {
      path: ['\\.(spec|e2e-spec)\\.ts$', '/dist/', '/coverage/', '^tooling/lint-fixtures/'],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'require', 'default'],
      mainFields: ['types', 'main'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: '^(apps/[^/]+|packages/[^/]+/[^/]+|tooling)',
        theme: { graph: { rankdir: 'LR', splines: 'ortho' } },
      },
    },
  },
};

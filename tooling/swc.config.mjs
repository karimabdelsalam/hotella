/** Shared SWC options: TypeScript + legacy decorators with metadata (NestJS), CommonJS output. */
export const swcOptions = {
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    keepClassNames: true,
  },
  module: { type: 'commonjs', strictMode: true },
  sourceMaps: true,
};

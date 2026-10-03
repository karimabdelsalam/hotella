/**
 * Package-relative paths. The build emits CommonJS until the planned NestJS 12/ESM move (ADR-0016),
 * so this is the ONE sanctioned use of __dirname in the codebase; it becomes import.meta.url then.
 */
declare const __dirname: string;
export function packageRoot(): string {
  return `${__dirname}/..`;
}

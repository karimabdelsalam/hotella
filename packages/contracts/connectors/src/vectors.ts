import { z } from 'zod';
import { type ConnectorAdapter, rawInboundMessageSchema } from './manifest';

/**
 * The contract-test kit of Connector SDK v2 (ADR-0024): a connector ships JSON vectors — raw vendor messages and the
 * connector-neutral records (or the refusal) they must produce — and every implementation of the same profile is
 * checked against them. A vendor adapter added later passes the neutral connector's vectors or it does not ship.
 */
export const connectorVectorsSchema = z.object({
  connector: z.string().regex(/^[A-Z][A-Z0-9_]{1,47}$/),
  version: z.number().int().min(1),
  /** The property timezone the cases are parsed in (sources such as FIAS send local wall-clock times). */
  timezone: z.string().min(1).default('UTC'),
  received_at: z.iso.datetime({ offset: true }).default('2026-01-01T00:00:00Z'),
  cases: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        message: rawInboundMessageSchema,
        expect: z.discriminatedUnion('ok', [
          z.object({ ok: z.literal(true), records: z.array(z.unknown()) }),
          z.object({ ok: z.literal(false), error_contains: z.string().min(1).optional() }),
        ]),
      }),
    )
    .min(1),
});
export type ConnectorVectors = z.infer<typeof connectorVectorsSchema>;
export type ConnectorVectorsInput = z.input<typeof connectorVectorsSchema>;

/** JSON with sorted keys, so two records compare by content and not by key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Runs every case through the adapter; returns one line per failing case (empty when the adapter conforms). */
export function checkConnectorVectors(
  adapter: ConnectorAdapter,
  input: ConnectorVectorsInput,
): string[] {
  const vectors = connectorVectorsSchema.parse(input);
  const failures: string[] = [];
  if (vectors.connector !== adapter.manifest.code)
    failures.push(`vectors are for ${vectors.connector}, the adapter is ${adapter.manifest.code}`);
  for (const c of vectors.cases) {
    const result = adapter.parse(c.message, {
      timezone: vectors.timezone,
      receivedAt: vectors.received_at,
    });
    if (c.expect.ok) {
      if (!result.ok) failures.push(`${c.name}: refused (${result.error})`);
      else if (canonical(result.records) !== canonical(c.expect.records))
        failures.push(
          `${c.name}: records differ\n  expected ${canonical(c.expect.records)}\n  received ${canonical(result.records)}`,
        );
    } else if (result.ok) failures.push(`${c.name}: accepted, expected a refusal`);
    else if (c.expect.error_contains && !result.error.includes(c.expect.error_contains))
      failures.push(
        `${c.name}: refused with "${result.error}", expected "${c.expect.error_contains}"`,
      );
  }
  return failures;
}

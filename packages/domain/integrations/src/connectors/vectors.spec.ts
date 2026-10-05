import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkConnectorVectors, type ConnectorVectorsInput } from '@hotella/contracts-connectors';
import { describe, expect, it } from 'vitest';
import { simPmsAdapter } from './sim-pms';
import { ConnectorRegistry } from './registry';

const dir = join(process.cwd(), 'test-vectors');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('connector contract vectors (Connector SDK v2 kit)', () => {
  const registry = new ConnectorRegistry();

  it.each(files)('%s: the registered adapter produces exactly the expected records', (file) => {
    const vectors = JSON.parse(readFileSync(join(dir, file), 'utf8')) as ConnectorVectorsInput;
    const adapter = registry.get(vectors.connector);
    expect(adapter, `${vectors.connector} is not registered`).toBeDefined();
    expect(checkConnectorVectors(adapter!, vectors)).toEqual([]);
  });

  it('reports a wrong record, an unexpected acceptance and a vector for another connector', () => {
    const message = {
      message_type: 'FIAS_RECORD',
      source_message_id: 'k-1',
      payload: { record: 'GO|RN301|G#R100|DA261006|TI110000|' },
    };
    const failures = checkConnectorVectors(simPmsAdapter, {
      connector: 'OTHER',
      version: 1,
      cases: [
        { name: 'wrong', message, expect: { ok: true, records: [{ kind: 'CHECK_IN' }] } },
        { name: 'accepted', message, expect: { ok: false } },
      ],
    });
    expect(failures).toHaveLength(3);
    expect(failures[0]).toBe('vectors are for OTHER, the adapter is SIM_PMS');
    expect(failures[1]).toMatch(/^wrong: records differ/);
    expect(failures[2]).toBe('accepted: accepted, expected a refusal');
  });
});

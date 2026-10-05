import { describe, expect, it } from 'vitest';
import { ERP_STANDARD_MANIFEST } from '@hotella/domain-integrations';
import type { CommandFrame, QueryFrame } from '../agent/link-client';
import { SimulatedErp } from './stores';

const query = (items: string[]) =>
  ({ type: 'query', query_type: 'ERP_STOCK', params: { items } }) as unknown as QueryFrame;
const command = (payload: unknown) =>
  ({ type: 'command', command_type: 'REQUISITION_CREATE', payload }) as unknown as CommandFrame;

describe('SimulatedErp', () => {
  const erp = new SimulatedErp({
    'FLT-20': [
      { onHand: 12, unit: 'EA', warehouse: 'MAIN' },
      { onHand: 3, unit: 'EA', warehouse: 'ENG' },
    ],
  });

  it('answers stock rows the ERP_STANDARD manifest accepts', async () => {
    const { rows } = await erp.onQuery(query(['FLT-20', 'UNKNOWN']));
    const row = ERP_STANDARD_MANIFEST.queries!.find((q) => q.code === 'ERP_STOCK')!.row;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(row.safeParse(r).success).toBe(true);
  });

  it('records requisitions once and refuses blocked items', async () => {
    const payload = {
      requisition_ref: '01900000-0000-7000-8000-000000000001',
      lines: [{ item_code: 'FLT-20', quantity: 4, unit: 'EA' }],
      needed_by: null,
    };
    expect(await erp.onCommand(command(payload))).toEqual({ status: 'ACKNOWLEDGED' });
    expect(await erp.onCommand(command(payload))).toEqual({ status: 'ACKNOWLEDGED' });
    expect(erp.requisitions).toHaveLength(1);
    erp.blockedItems.add('FLT-20');
    expect(
      await erp.onCommand(
        command({ ...payload, requisition_ref: '01900000-0000-7000-8000-000000000002' }),
      ),
    ).toMatchObject({ status: 'FAILED' });
  });
});

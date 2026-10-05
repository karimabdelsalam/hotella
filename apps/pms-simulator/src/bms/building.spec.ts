import { createHmac } from 'node:crypto';
import { telemetryBatchPayloadSchema } from '@hotella/contracts-connectors';
import { describe, expect, it } from 'vitest';
import { CHILLER_SCENARIO, inboundBody, inboundSignature, samplesBetween } from './building';

const START = new Date('2026-10-05T10:00:00Z');

describe('the simulated plant room', () => {
  it('climbs past the chiller limit, holds, and recovers — the same every run', () => {
    const supply = CHILLER_SCENARIO[0]!;
    expect([0, 4, 5, 8, 9, 11, 12, 13, 14].map(supply.valueAt)).toEqual([
      6.5, 6.5, 7.5, 10.5, 10.5, 10.5, 8.5, 8.5, 6.5,
    ]);
  });
  it('sends profile-valid batches of at most 500 samples, one per point and minute', () => {
    const samples = samplesBetween(CHILLER_SCENARIO, START, 0, 200);
    expect(samples).toHaveLength(600);
    expect(samples[3]).toEqual({
      point: 'CH-1.SUPPLY_T',
      value: 6.5,
      at: '2026-10-05T10:01:05.000Z',
    });
    const body = JSON.parse(inboundBody(samples, 'sim')) as {
      messages: Array<{ source_message_id: string; payload: unknown }>;
    };
    expect(body.messages.map((m) => m.source_message_id)).toEqual(['sim-0', 'sim-1']);
    for (const m of body.messages)
      expect(telemetryBatchPayloadSchema.safeParse(m.payload).success).toBe(true);
  });
  it('signs the exact body the way the ingress verifies it', () => {
    const body = inboundBody(samplesBetween(CHILLER_SCENARIO, START, 0, 1), 'sim');
    const header = inboundSignature('whin_secret', body, START);
    const t = Math.floor(START.getTime() / 1000);
    expect(header).toBe(
      `t=${t},v1=${createHmac('sha256', 'whin_secret').update(`${t}.${body}`).digest('hex')}`,
    );
  });
});

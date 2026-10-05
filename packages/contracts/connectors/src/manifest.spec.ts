import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ConnectorDefinitionError,
  defineConnector,
  inboundBatchSchema,
  transportsOf,
} from './index';

const base = {
  code: 'TEST_CLOUD',
  version: 1,
  category: 'PMS' as const,
  description: 'test',
  capabilities: ['CHECKIN_EVENT', 'ROOM_STATUS_WRITE'] as const,
  messageTypes: [{ code: 'EVENT', description: 'x', requires: 'CHECKIN_EVENT' as const }],
  commands: [],
  configSchema: z.object({}),
  credentialSchema: z.object({}),
};

describe('connector transports (ADR-0024)', () => {
  it('defaults to the agent link and accepts webhooks', () => {
    expect(transportsOf(defineConnector({ ...base }))).toEqual(['AGENT']);
    expect(transportsOf(defineConnector({ ...base, transports: ['AGENT', 'WEBHOOK'] }))).toEqual([
      'AGENT',
      'WEBHOOK',
    ]);
  });

  it('refuses no transport, unknown ones, and commands on a webhook-only connector', () => {
    expect(() => defineConnector({ ...base, transports: [] })).toThrow(ConnectorDefinitionError);
    expect(() => defineConnector({ ...base, transports: ['FTP' as never] })).toThrow(
      /unknown transport/,
    );
    expect(() =>
      defineConnector({
        ...base,
        transports: ['WEBHOOK'],
        commands: [
          { code: 'SET', description: 'x', requires: 'ROOM_STATUS_WRITE', payload: z.object({}) },
        ],
      }),
    ).toThrow(/webhook-only/);
  });
});

describe('inbound batch', () => {
  it('takes 1–100 raw messages without a link sequence', () => {
    const one = { message_type: 'EVENT', source_message_id: 'm1', payload: {} };
    expect(inboundBatchSchema.parse({ messages: [one] }).messages[0]).toMatchObject({
      sequence_no: null,
      occurred_at: null,
    });
    expect(inboundBatchSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(inboundBatchSchema.safeParse({ messages: [{ ...one, sequence_no: 3 }] }).success).toBe(
      false,
    );
    expect(
      inboundBatchSchema.safeParse({ messages: Array.from({ length: 101 }, () => one) }).success,
    ).toBe(false);
  });
});

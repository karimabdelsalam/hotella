import { describe, expect, it } from 'vitest';
import type { CommandFrame } from '../agent/link-client';
import { SimulatedAccessSystems } from './systems';

const frame = (command_type: string, payload: Record<string, unknown>) =>
  ({ type: 'command', command_type, payload }) as unknown as CommandFrame;

describe('the simulated lock and Wi-Fi systems', () => {
  it('issue and revoke by grant, idempotently, and refuse what they cannot do', async () => {
    const s = new SimulatedAccessSystems();
    const encode = { grant_id: 'g1', room_number: '504', valid_until: '2026-10-08T11:00:00Z' };
    expect(await s.handle(frame('KEY_ENCODE', encode))).toEqual({ status: 'ACKNOWLEDGED' });
    expect(s.live.get('g1')).toMatchObject({ roomNumber: '504', kind: 'KEY' });
    expect(await s.handle(frame('KEY_REVOKE', { grant_id: 'g1' }))).toEqual({
      status: 'ACKNOWLEDGED',
    });
    expect(await s.handle(frame('KEY_REVOKE', { grant_id: 'g1' }))).toEqual({
      status: 'ACKNOWLEDGED',
    });
    expect(s.live.size).toBe(0);
    s.failingRooms.add('505');
    expect(
      await s.handle(
        frame('WIFI_SESSION_CREATE', { ...encode, grant_id: 'g2', room_number: '505' }),
      ),
    ).toEqual({ status: 'FAILED', error: 'encoder offline' });
    expect(await s.handle(frame('OPEN_DOOR', { grant_id: 'g3' }))).toMatchObject({
      status: 'FAILED',
    });
    expect(s.log.map((l) => `${l.type}:${l.ok}`)).toEqual([
      'KEY_ENCODE:true',
      'KEY_REVOKE:true',
      'KEY_REVOKE:true',
      'WIFI_SESSION_CREATE:false',
      'OPEN_DOOR:false',
    ]);
  });
});

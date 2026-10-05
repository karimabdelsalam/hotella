import { describe, expect, it } from 'vitest';
import { GUEST_CONCIERGE } from './agents';
import { toolsFor } from './caller-assurance';

describe('caller assurance (ADR-0025, Q27)', () => {
  it('a verified guest keeps every tool of the concierge', () => {
    expect(toolsFor(GUEST_CONCIERGE.tools, 'VERIFIED')).toEqual([...GUEST_CONCIERGE.tools]);
  });

  it('a room-context caller cannot read the guest, book, cancel or reach any tool outside the allowlist', () => {
    const tools = toolsFor(GUEST_CONCIERGE.tools, 'ROOM_CONTEXT');
    expect(tools).toEqual(
      expect.arrayContaining([
        'operations.create_service_request',
        'housekeeping.set_room_signal',
        'communication.send_message',
      ]),
    );
    for (const sensitive of [
      'guest.get_current_stay',
      'operations.cancel_service_request',
      'restaurant.book_table',
    ])
      expect(tools).not.toContain(sensitive);
    expect(toolsFor(['access.issue_key', 'catalog.list_services'], 'ROOM_CONTEXT')).toEqual([
      'catalog.list_services',
    ]);
  });
});

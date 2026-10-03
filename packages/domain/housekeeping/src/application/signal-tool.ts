import { z } from 'zod';
import type { AiToolDefinition } from '@hotella/domain-ai/public';
import type { GuestPublicApi } from '@hotella/domain-guest/public';
import { AppError } from '@hotella/platform-i18n';
import type { HousekeepingPublicApi } from '../public';

/**
 * `housekeeping.set_room_signal` (LOW, `hk.room.manage`): the concierge sets "do not disturb" or "please make up my
 * room" for its own guest's current room, as the guest asked in the chat. Only that room; recorded with source
 * GUEST_PORTAL (the guest's own request) and the AI execution as actor.
 */
export function setRoomSignalTool(
  housekeeping: HousekeepingPublicApi,
  guests: GuestPublicApi,
): AiToolDefinition<{ signal: 'DND' | 'MAKE_UP_ROOM'; active: boolean }> {
  return {
    code: 'housekeeping.set_room_signal',
    description:
      'Turns "do not disturb" (DND) or "please make up my room" (MAKE_UP_ROOM) on or off for the guest’s own room. Turning one on turns the other off.',
    risk: 'LOW',
    requiredPermission: 'hk.room.manage',
    input: z.object({ signal: z.enum(['DND', 'MAKE_UP_ROOM']), active: z.boolean() }).strict(),
    needs: { guest: true },
    handle: async (args, ctx) => {
      const stay = ctx.guest ? await guests.getStay(ctx.tenantId, ctx.guest.stayId) : null;
      if (
        !stay ||
        stay.status !== 'IN_HOUSE' ||
        !stay.currentRoomId ||
        stay.propertyId !== ctx.propertyId
      )
        throw AppError.conflict('hk.signal.no_room');
      const result = await housekeeping.setGuestRoomSignal({
        tenantId: ctx.tenantId,
        propertyId: ctx.propertyId,
        roomId: stay.currentRoomId,
        signal: args.signal,
        active: args.active,
        actor: { type: 'AI_AGENT', id: ctx.executionId },
      });
      return { active_signals: result.active };
    },
  };
}

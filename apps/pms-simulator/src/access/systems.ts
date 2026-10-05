import type { CommandFrame, CommandHandler } from '../agent/link-client';

interface Issued {
  readonly roomNumber: string;
  readonly validUntil: string;
  readonly kind: 'KEY' | 'MOBILE_KEY' | 'WIFI';
}

/**
 * The lock and Wi-Fi faces of the simulator (BUILD_PLAN 13.3): a hotel's door-lock system and guest Wi-Fi answering
 * the Planova Lock and Wi-Fi Profile commands. What they "issue" stays here, as in a real vendor system — the platform
 * only learns that it worked. Rooms listed in `out of order` refuse, so a failure can be played.
 */
export class SimulatedAccessSystems {
  /** Live keys and Wi-Fi sessions by the platform's grant id. */
  readonly live = new Map<string, Issued>();
  /** Every command answered, in order (for scenarios and tests). */
  readonly log: Array<{ readonly type: string; readonly grantId: string; readonly ok: boolean }> =
    [];
  readonly failingRooms = new Set<string>();

  /** One handler for the agent link: lock and Wi-Fi commands (other types are refused). */
  readonly handle: CommandHandler = async (command: CommandFrame) => {
    const p = (command.payload ?? {}) as {
      grant_id?: string;
      room_number?: string;
      valid_until?: string;
    };
    const grantId = p.grant_id ?? '';
    const answer = (ok: boolean, error = 'refused') => {
      this.log.push({ type: command.command_type, grantId, ok });
      return ok ? { status: 'ACKNOWLEDGED' as const } : { status: 'FAILED' as const, error };
    };
    switch (command.command_type) {
      case 'KEY_ENCODE':
      case 'MOBILE_KEY_ISSUE':
      case 'WIFI_SESSION_CREATE': {
        if (!p.room_number || !p.valid_until) return answer(false, 'incomplete command');
        if (this.failingRooms.has(p.room_number)) return answer(false, 'encoder offline');
        this.live.set(grantId, {
          roomNumber: p.room_number,
          validUntil: p.valid_until,
          kind:
            command.command_type === 'KEY_ENCODE'
              ? 'KEY'
              : command.command_type === 'MOBILE_KEY_ISSUE'
                ? 'MOBILE_KEY'
                : 'WIFI',
        });
        return answer(true);
      }
      case 'KEY_REVOKE':
      case 'WIFI_SESSION_REVOKE':
        // Revoking what is not there is fine: revocation is idempotent.
        this.live.delete(grantId);
        return answer(true);
      default:
        return answer(false, `unsupported command ${command.command_type}`);
    }
  };
}

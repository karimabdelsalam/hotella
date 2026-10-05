import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AiToolDefinition, AiToolRegistrar, ToolContext } from '@hotella/domain-ai/public';
import { ReservationService } from './reservation.service';

/** Codes of the concierge's restaurant tools (declared in the manifest too). */
export const FIND_TABLES_TOOL = 'restaurant.find_tables';
export const BOOK_TABLE_TOOL = 'restaurant.book_table';

interface BookArgs {
  restaurant_id: string;
  sitting_id: string;
  date: string;
  party_size: number;
  notes?: string;
}

/**
 * The concierge's two restaurant tools (BUILD_PLAN 14.3). They act only for the guest of the execution, with the
 * scopes of that guest's live grant, through the same rules as the guest app: within the stay, the cut-off, the
 * party size, the seats and the stay's allowance per restaurant — the model never decides any of it.
 */
@Injectable()
export class RestaurantAiTools {
  constructor(private readonly reservations: ReservationService) {}

  registerInto(registry: AiToolRegistrar): void {
    registry.register(this.findTables());
    registry.register(this.bookTable());
  }

  private guest(ctx: ToolContext) {
    return this.reservations.conciergeGuest({
      tenantId: ctx.tenantId,
      propertyId: ctx.propertyId,
      guestId: ctx.guest!.guestId,
      stayId: ctx.guest!.stayId,
    });
  }

  findTables(): AiToolDefinition<Record<string, never>> {
    return {
      code: FIND_TABLES_TOOL,
      description:
        "The hotel's à la carte restaurants the guest can book during their stay, in their language: for each restaurant the bookings the stay has left there, and for each date the sittings with free seats (only those with bookable=true can be booked now). Also the guest's existing restaurant reservations.",
      risk: 'READ',
      requiredPermission: 'restaurant.offer.read',
      needs: { guest: true },
      input: z.object({}).strict(),
      handle: async (_args, ctx) => {
        const guest = await this.guest(ctx);
        const [offer, mine] = await Promise.all([
          this.reservations.guestOffer(guest, ctx.locale),
          this.reservations.guestReservations(guest, ctx.locale),
        ]);
        return {
          restaurants: offer.restaurants.map((r) => ({
            restaurant_id: r.id,
            name: r.name,
            description: r.description,
            dress_code: r.dressCode,
            party_size: { min: r.minParty, max: r.maxParty },
            bookings_left: r.allowance.remaining,
            dates: r.days
              .map((d) => ({
                date: d.date,
                sittings: d.sittings
                  .filter((s) => s.bookable)
                  .map((s) => ({
                    sitting_id: s.sittingId,
                    starts_at: s.startsAt,
                    free_seats: s.free,
                  })),
              }))
              .filter((d) => d.sittings.length > 0),
          })),
          reservations: mine
            .filter((m) => m.status === 'CONFIRMED')
            .map((m) => ({
              restaurant: m.restaurant?.name ?? null,
              date: m.serviceDate,
              starts_at: m.startsAt,
              party_size: m.partySize,
            })),
        };
      },
    };
  }

  bookTable(): AiToolDefinition<BookArgs> {
    return {
      code: BOOK_TABLE_TOOL,
      description:
        'Books a table for the guest at an à la carte restaurant (ids from restaurant.find_tables). Confirm restaurant, date, time and number of people with the guest first. The hotel allows a limited number of bookings per restaurant per stay; if the answer says the allowance is used, the sitting is full or the cut-off has passed, tell the guest and offer another sitting or the front desk.',
      risk: 'MEDIUM',
      requiredPermission: 'restaurant.reservation.book_own',
      needs: { guest: true },
      input: z
        .object({
          restaurant_id: z.uuid(),
          sitting_id: z.uuid(),
          date: z.iso.date(),
          party_size: z.number().int().min(1).max(50),
          notes: z.string().trim().max(500).optional(),
        })
        .strict(),
      handle: async (args, ctx) => {
        const booked = await this.reservations.guestBook(
          await this.guest(ctx),
          {
            restaurantId: args.restaurant_id,
            sittingId: args.sitting_id,
            serviceDate: args.date,
            partySize: args.party_size,
            notes: args.notes ?? null,
          },
          'AI',
        );
        return {
          reservation_id: booked.id,
          status: booked.status,
          date: booked.serviceDate,
          starts_at: booked.startsAt,
          party_size: booked.partySize,
        };
      },
    };
  }
}

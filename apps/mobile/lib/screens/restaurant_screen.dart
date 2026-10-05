import 'package:flutter/material.dart';

import '../api/hotella_api.g.dart';
import '../l10n/app_localizations.dart';
import '../session.dart';
import '../widgets/screen.dart';

String _isoDate(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// The restaurant board of a day: each restaurant's sittings, seats booked and the bookings in them.
class RestaurantScreen extends StatefulWidget {
  const RestaurantScreen({super.key, required this.state, this.today});
  final AppState state;

  /// The day to start on (tests); otherwise today on this phone.
  final DateTime? today;

  @override
  State<RestaurantScreen> createState() => _RestaurantScreenState();
}

class _RestaurantScreenState extends State<RestaurantScreen> {
  late DateTime _day = widget.today ?? DateTime.now();

  void _move(int days) => setState(() => _day = DateTime(_day.year, _day.month, _day.day + days));

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final state = widget.state;
    final date = _isoDate(_day);
    return AppScreen(
      state: state,
      title: t.restaurantTitle,
      body: Column(
        children: [
          Row(
            children: [
              IconButton(
                key: const Key('day-previous'),
                tooltip: t.restaurantPreviousDay,
                icon: const Icon(Icons.chevron_left),
                onPressed: () => _move(-1),
              ),
              Expanded(
                child: Text(
                  formatDate(context, date),
                  key: const Key('day'),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                key: const Key('day-next'),
                tooltip: t.restaurantNextDay,
                icon: const Icon(Icons.chevron_right),
                onPressed: () => _move(1),
              ),
            ],
          ),
          Expanded(
            child: LoadView(
              key: ValueKey(date),
              load: () => state.load('restaurant.$date', (p) => state.api.restaurantBoard(p, date: date)),
              builder: (context, data, reload) {
                final restaurants = data.list;
                final hasBookings = restaurants.any(
                  (r) => r['sittings'].list.any((s) => s['reservations'].list.isNotEmpty),
                );
                if (!hasBookings) return emptyList(t.restaurantEmpty, key: const Key('restaurant-empty'));
                return ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: [
                    for (final r in restaurants) ...[
                      Padding(
                        padding: const EdgeInsetsDirectional.fromSTEB(16, 16, 16, 4),
                        child: Text(r['name'] as String? ?? '', style: Theme.of(context).textTheme.titleLarge),
                      ),
                      for (final s in r['sittings'].list)
                        if (s['reservations'].list.isNotEmpty) ...[
                          ListTile(
                            dense: true,
                            title: Text(
                              s['startsAt'] as String? ?? '',
                              style: Theme.of(context).textTheme.titleSmall,
                            ),
                            trailing: Text(t.restaurantSeats('${s['booked'] ?? 0}', '${s['seats'] ?? 0}')),
                          ),
                          for (final b in s['reservations'].list)
                            if (b['status'] != 'CANCELLED')
                              ListTile(
                                key: Key('reservation-${b['id']}'),
                                leading: const Icon(Icons.table_restaurant_outlined),
                                title: Text(
                                  [
                                    if (b['roomNumber'] != null) t.reservationRoom(b['roomNumber']! as String),
                                    if (b['guestName'] != null) b['guestName']! as String,
                                  ].join(' · '),
                                ),
                                subtitle: Text(
                                  '${t.reservationParty(b['partySize'] as int? ?? 1)} · '
                                  '${t.reservationStatus(b['status'] as String? ?? '')}',
                                ),
                                onTap: () async {
                                  await Navigator.of(context).push(
                                    MaterialPageRoute<void>(
                                      builder: (_) =>
                                          ReservationScreen(state: state, reservationId: b['id']! as String),
                                    ),
                                  );
                                  await reload();
                                },
                              ),
                        ],
                    ],
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// One booking (a push for a new booking opens it): who, when, notes; seat, finish or mark a no-show.
class ReservationScreen extends StatelessWidget {
  const ReservationScreen({super.key, required this.state, required this.reservationId});
  final AppState state;
  final String reservationId;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return AppScreen(
      state: state,
      title: t.reservationTitle,
      body: LoadView(
        load: () => state.load('reservation.$reservationId', (p) => state.api.getReservation(p, reservationId)),
        builder: (context, data, reload) {
          final b = data.map;
          final status = b['status'] as String? ?? '';
          final body = TransitionDto(version: b['version'] as int? ?? 1);
          final manage = state.can('restaurant.reservation.manage');
          Future<void> run(Future<Object?> Function(String p) action) =>
              act(context, () => action(state.propertyId!), reload);
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsetsDirectional.all(16),
            children: [
              if (b['restaurantName'] != null)
                Text(
                  b['restaurantName']! as String,
                  key: const Key('reservation-restaurant'),
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
              const SizedBox(height: 4),
              Text(
                t.reservationWhen(formatDate(context, b['serviceDate'] as String? ?? ''), b['startsAt'] as String? ?? ''),
                key: const Key('reservation-when'),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: [
                  Chip(key: const Key('reservation-status'), label: Text(t.reservationStatus(status))),
                  Chip(label: Text(t.reservationParty(b['partySize'] as int? ?? 1))),
                  if (b['roomNumber'] != null) Chip(label: Text(t.reservationRoom(b['roomNumber']! as String))),
                ],
              ),
              if (b['guestName'] != null) ...[
                const SizedBox(height: 8),
                Text(b['guestName']! as String, key: const Key('reservation-guest')),
              ],
              if ((b['notes'] as String?)?.isNotEmpty ?? false) ...[
                const SizedBox(height: 16),
                Text(t.reservationNotes, style: Theme.of(context).textTheme.titleSmall),
                Text(b['notes']! as String),
              ],
              const SizedBox(height: 24),
              if (manage && status == 'CONFIRMED') ...[
                FilledButton.icon(
                  key: const Key('reservation-seat'),
                  icon: const Icon(Icons.event_seat),
                  label: Text(t.reservationSeat),
                  onPressed: () => run((p) => state.api.seatReservation(p, reservationId, body)),
                ),
                const SizedBox(height: 8),
                OutlinedButton(
                  key: const Key('reservation-no-show'),
                  onPressed: () => run((p) => state.api.noShowReservation(p, reservationId, body)),
                  child: Text(t.reservationNoShow),
                ),
              ],
              if (manage && status == 'SEATED')
                FilledButton.tonal(
                  key: const Key('reservation-complete'),
                  onPressed: () => run((p) => state.api.completeReservation(p, reservationId, body)),
                  child: Text(t.reservationComplete),
                ),
            ],
          );
        },
      ),
    );
  }
}

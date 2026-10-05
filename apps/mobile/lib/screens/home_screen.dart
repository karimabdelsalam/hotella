import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../session.dart';
import '../widgets/common.dart';

/// A part of the app and the permission that opens it (the screens themselves arrive in Sprint 14.6).
typedef Section = ({String key, String permission, IconData icon});

const sections = <Section>[
  (key: 'tasks', permission: 'task.read', icon: Icons.checklist),
  (key: 'requests', permission: 'request.read', icon: Icons.room_service_outlined),
  (key: 'alerts', permission: 'alert.read', icon: Icons.notifications_active_outlined),
  (key: 'restaurant', permission: 'restaurant.reservation.read', icon: Icons.restaurant),
];

/// After sign-in: the hotel, the person, the property they work at and the parts of the app their permissions open.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.state, required this.baseUrl});
  final AppState state;
  final String baseUrl;

  String _label(AppLocalizations t, String key) => switch (key) {
    'tasks' => t.homeSectionTasks,
    'requests' => t.homeSectionRequests,
    'alerts' => t.homeSectionAlerts,
    _ => t.homeSectionRestaurant,
  };

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final hotel = state.hotel!;
    final me = state.me!;
    final propertyId = state.propertyId;
    final held = propertyId == null ? <String>{} : me.permissionsAt(propertyId);
    final open = sections.where((s) => held.contains(s.permission)).toList();
    return Scaffold(
      appBar: AppBar(
        title: Text(hotel.displayName, key: const Key('hotel-name')),
        actions: [
          LanguageMenu(state: state),
          IconButton(
            key: const Key('sign-out'),
            tooltip: t.homeSignOut,
            icon: const Icon(Icons.logout),
            onPressed: state.signOut,
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsetsDirectional.all(16),
          children: [
            Row(
              children: [
                HotelMark(hotel: hotel, baseUrl: baseUrl, size: 44),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    me.givenName == null ? t.homeWelcomePlain : t.homeWelcome(me.givenName!),
                    key: const Key('welcome'),
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                ),
              ],
            ),
            if (state.properties.length > 1) ...[
              const SizedBox(height: 16),
              DropdownButtonFormField<String>(
                key: const Key('property'),
                initialValue: propertyId,
                decoration: InputDecoration(labelText: t.homeProperty, border: const OutlineInputBorder()),
                items: [for (final p in state.properties) DropdownMenuItem(value: p.id, child: Text(p.name))],
                onChanged: (id) => id == null ? null : state.selectProperty(id),
              ),
            ],
            const SizedBox(height: 24),
            Text(
              open.isEmpty ? t.homeNoSections : t.homeSections(open.length),
              key: const Key('sections-title'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            for (final s in open)
              Card(
                child: ListTile(key: Key('section-${s.key}'), leading: Icon(s.icon), title: Text(_label(t, s.key))),
              ),
            PoweredBy(hotel: hotel),
          ],
        ),
      ),
    );
  }
}

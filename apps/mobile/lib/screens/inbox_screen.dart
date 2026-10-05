import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../session.dart';
import '../widgets/screen.dart';
import 'restaurant_screen.dart';
import 'tasks_screen.dart';
import 'work_screen.dart';

/// The screen a notification is about, or null when the app has none for it (it stays in the inbox).
Widget? screenFor(AppState state, String? type, String? id) {
  if (type == null || id == null) return null;
  return switch (type) {
    'task' => TaskScreen(state: state, taskId: id),
    'work_item' => WorkItemScreen(state: state, workItemId: id),
    'restaurant_reservation' => ReservationScreen(state: state, reservationId: id),
    _ => null,
  };
}

/// Opens what a tapped push is about: its screen, else the inbox.
Future<void> openTarget(NavigatorState navigator, AppState state, PushTarget target) async {
  final screen = screenFor(state, target.type, target.id) ?? InboxScreen(state: state);
  await navigator.push(MaterialPageRoute<void>(builder: (_) => screen));
  await state.refreshUnread();
}

/// The person's notifications at the selected property (the same ones pushed to the phone, with their text).
class InboxScreen extends StatelessWidget {
  const InboxScreen({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return AppScreen(
      state: state,
      title: t.inboxTitle,
      body: LoadView(
        load: () => state.load('inbox', (p) => state.api.listNotifications(p, limit: '50')),
        builder: (context, data, reload) {
          final items = data.list;
          if (items.isEmpty) return emptyList(t.inboxEmpty, key: const Key('inbox-empty'));
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              for (final n in items)
                ListTile(
                  key: Key('notification-${n['id']}'),
                  leading: Icon(n['readAt'] == null ? Icons.circle : Icons.circle_outlined, size: 12),
                  title: Text(
                    n['title'] as String? ?? '',
                    style: n['readAt'] == null ? const TextStyle(fontWeight: FontWeight.bold) : null,
                  ),
                  subtitle: Text('${n['body'] ?? ''}\n${formatMoment(context, n['createdAt'] as String?)}'),
                  isThreeLine: true,
                  onTap: () async {
                    final navigator = Navigator.of(context);
                    if (n['readAt'] == null) {
                      try {
                        await state.api.markNotificationRead(state.propertyId!, n['id']! as String);
                      } on Object {
                        // Read again next time.
                      }
                    }
                    final source = n['source'].map;
                    final screen = screenFor(state, source['type'] as String?, source['id'] as String?);
                    if (screen != null) await navigator.push(MaterialPageRoute<void>(builder: (_) => screen));
                    await reload();
                    await state.refreshUnread();
                  },
                ),
            ],
          );
        },
      ),
    );
  }
}

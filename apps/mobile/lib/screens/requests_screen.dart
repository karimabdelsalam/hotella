import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../session.dart';
import '../widgets/screen.dart';
import 'work_screen.dart';

/// Open guest requests at the selected property (the work behind them is done through tasks).
class RequestsScreen extends StatelessWidget {
  const RequestsScreen({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return AppScreen(
      state: state,
      title: t.requestsTitle,
      body: LoadView(
        load: () => state.load(
          'requests',
          (p) => state.api.listServiceRequests(p, status: 'OPEN,IN_PROGRESS', limit: '100'),
        ),
        builder: (context, data, reload) {
          final items = data.list;
          if (items.isEmpty) return emptyList(t.requestsEmpty, key: const Key('requests-empty'));
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              for (final r in items)
                ListTile(
                  key: Key('request-${r['id']}'),
                  leading: const Icon(Icons.room_service_outlined),
                  title: Text(r['serviceName'] as String? ?? ''),
                  subtitle: Text(
                    [
                      if (r['roomNumber'] != null) t.requestRoom(r['roomNumber']! as String),
                      if (r['guestName'] != null) r['guestName']! as String,
                      t.requestAskedAt(formatMoment(context, r['createdAt'] as String?)),
                    ].join(' · '),
                  ),
                  trailing: Text(t.requestStatus(r['status'] as String? ?? '')),
                  onTap: () async {
                    await Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => RequestScreen(state: state, requestId: r['id']! as String),
                      ),
                    );
                    await reload();
                  },
                ),
            ],
          );
        },
      ),
    );
  }
}

/// One guest request: what was asked, for when, how often, and the work behind it.
class RequestScreen extends StatelessWidget {
  const RequestScreen({super.key, required this.state, required this.requestId});
  final AppState state;
  final String requestId;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return AppScreen(
      state: state,
      title: t.requestTitle,
      body: LoadView(
        load: () => state.load('request.$requestId', (p) => state.api.getServiceRequest(p, requestId)),
        builder: (context, data, reload) {
          final r = data.map;
          final related = r['relatedCount'] as int? ?? 0;
          final workItemId = r['workItemId'] as String?;
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsetsDirectional.all(16),
            children: [
              Text(
                r['serviceName'] as String? ?? '',
                key: const Key('request-title'),
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 8),
              Chip(label: Text(t.requestStatus(r['status'] as String? ?? ''))),
              const SizedBox(height: 8),
              if (r['roomNumber'] != null) Text(t.requestRoom(r['roomNumber']! as String)),
              Text(t.requestAskedAt(formatMoment(context, r['createdAt'] as String?))),
              if (r['requestedForAt'] != null)
                Text(t.requestWantedFor(formatMoment(context, r['requestedForAt'] as String?))),
              if (related > 0) Text(t.requestAskedAgain(related)),
              if (workItemId != null && state.can('task.read')) ...[
                const SizedBox(height: 16),
                OutlinedButton.icon(
                  key: const Key('request-work'),
                  icon: const Icon(Icons.checklist),
                  label: Text(t.workTasks),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(builder: (_) => WorkItemScreen(state: state, workItemId: workItemId)),
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

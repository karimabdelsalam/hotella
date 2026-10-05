import 'package:flutter/material.dart';

import '../api/hotella_api.g.dart';
import '../l10n/app_localizations.dart';
import '../session.dart';
import '../widgets/screen.dart';
import 'work_screen.dart';

/// Open and acknowledged alerts at the selected property; acknowledge and resolve them where allowed.
class AlertsScreen extends StatelessWidget {
  const AlertsScreen({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final scheme = Theme.of(context).colorScheme;
    return AppScreen(
      state: state,
      title: t.alertsTitle,
      body: LoadView(
        load: () => state.load('alerts', (p) => state.api.listAlerts(p, status: 'OPEN,ACKNOWLEDGED', limit: '100')),
        builder: (context, data, reload) {
          final items = data.list;
          if (items.isEmpty) return emptyList(t.alertsEmpty, key: const Key('alerts-empty'));
          final manage = state.can('alert.ack');
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              for (final a in items)
                Card(
                  key: Key('alert-${a['id']}'),
                  margin: const EdgeInsetsDirectional.symmetric(horizontal: 12, vertical: 6),
                  child: Padding(
                    padding: const EdgeInsetsDirectional.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(
                              a['severity'] == 'INFO' ? Icons.info_outline : Icons.warning_amber,
                              color: a['severity'] == 'CRITICAL' ? scheme.error : null,
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                t.alertType(a['type'] as String? ?? ''),
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          [
                            t.alertSeverity(a['severity'] as String? ?? ''),
                            t.alertStatus(a['status'] as String? ?? ''),
                            t.alertSeen(a['occurrences'] as int? ?? 1),
                            t.alertLastSeen(formatMoment(context, a['lastSeenAt'] as String?)),
                          ].join(' · '),
                        ),
                        Wrap(
                          spacing: 8,
                          children: [
                            if (a['subject'].map['type'] == 'work_item' && state.can('task.read'))
                              TextButton(
                                onPressed: () => Navigator.of(context).push(
                                  MaterialPageRoute<void>(
                                    builder: (_) =>
                                        WorkItemScreen(state: state, workItemId: a['subject'].map['id']! as String),
                                  ),
                                ),
                                child: Text(t.workTitle),
                              ),
                            if (manage && a['status'] == 'OPEN')
                              FilledButton.tonal(
                                key: Key('alert-ack-${a['id']}'),
                                onPressed: () => act(
                                  context,
                                  () => state.api.acknowledgeAlert(state.propertyId!, a['id']! as String),
                                  reload,
                                ),
                                child: Text(t.alertAcknowledge),
                              ),
                            if (manage)
                              OutlinedButton(
                                key: Key('alert-resolve-${a['id']}'),
                                onPressed: () async {
                                  final resolution = await askText(context, t.alertResolution);
                                  if (resolution == null || !context.mounted) return;
                                  await act(
                                    context,
                                    () => state.api.resolveAlert(
                                      state.propertyId!,
                                      a['id']! as String,
                                      ResolveAlertDto(resolution: resolution),
                                    ),
                                    reload,
                                  );
                                },
                                child: Text(t.alertResolve),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

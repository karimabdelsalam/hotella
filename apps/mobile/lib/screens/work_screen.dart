import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../session.dart';
import '../widgets/screen.dart';
import 'tasks_screen.dart';

/// A piece of work (an escalation opens it) and its tasks.
class WorkItemScreen extends StatelessWidget {
  const WorkItemScreen({super.key, required this.state, required this.workItemId});
  final AppState state;
  final String workItemId;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return AppScreen(
      state: state,
      title: t.workTitle,
      body: LoadView(
        load: () => state.load('work.$workItemId', (p) => state.api.getWorkItem(p, workItemId)),
        builder: (context, data, reload) {
          final item = data.map;
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsetsDirectional.all(16),
            children: [
              Text(
                item['title'] as String? ?? '',
                key: const Key('work-title'),
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: [
                  Chip(key: const Key('work-status'), label: Text(t.workStatus(item['status'] as String? ?? ''))),
                  Chip(label: Text(t.taskPriority(item['priority'] as String? ?? ''))),
                ],
              ),
              const SizedBox(height: 16),
              Text(t.workTasks, style: Theme.of(context).textTheme.titleMedium),
              for (final task in item['tasks'].list)
                ListTile(
                  key: Key('work-task-${task['id']}'),
                  title: Text(task['title'] as String? ?? ''),
                  subtitle: Text(t.taskStatus(task['status'] as String? ?? '')),
                  onTap: () async {
                    await Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => TaskScreen(state: state, taskId: task['id']! as String),
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

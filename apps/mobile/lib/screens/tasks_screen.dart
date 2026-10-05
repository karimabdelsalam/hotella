import 'package:flutter/material.dart';

import '../api/hotella_api.g.dart';
import '../l10n/app_localizations.dart';
import '../session.dart';
import '../widgets/screen.dart';

/// The tasks a person still has to do: assigned, accepted, in progress or paused.
const openTaskStatuses = 'ASSIGNED,ACCEPTED,IN_PROGRESS,PAUSED';

/// My tasks: what is assigned to the person at the selected property, newest first.
class TasksScreen extends StatelessWidget {
  const TasksScreen({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return AppScreen(
      state: state,
      title: t.tasksTitle,
      body: LoadView(
        load: () => state.load(
          'tasks',
          (p) => state.api.listTasks(p, assignee: 'me', status: openTaskStatuses, limit: '100'),
        ),
        builder: (context, data, reload) {
          final items = data.map['items'].list;
          if (items.isEmpty) return emptyList(t.tasksEmpty, key: const Key('tasks-empty'));
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              for (final task in items)
                ListTile(
                  key: Key('task-${task['id']}'),
                  leading: Icon(_icon(task['status'] as String?)),
                  title: Text(task['title'] as String? ?? ''),
                  subtitle: Text(
                    [
                      t.taskStatus(task['status'] as String? ?? ''),
                      if (task['priority'] != 'NORMAL') t.taskPriority(task['priority'] as String? ?? ''),
                      if (task['dueAt'] != null) t.taskDue(formatMoment(context, task['dueAt'] as String?)),
                    ].join(' · '),
                  ),
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

IconData _icon(String? status) => switch (status) {
  'IN_PROGRESS' => Icons.play_circle_outline,
  'PAUSED' => Icons.pause_circle_outline,
  'DONE' => Icons.check_circle_outline,
  _ => Icons.radio_button_unchecked,
};

/// One task and the one-tap moves the person may make on it (the lifecycle and permissions are checked by the API).
class TaskScreen extends StatelessWidget {
  const TaskScreen({super.key, required this.state, required this.taskId});
  final AppState state;
  final String taskId;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return AppScreen(
      state: state,
      title: t.taskTitle,
      body: LoadView(
        load: () => state.load('task.$taskId', (p) => state.api.getTask(p, taskId)),
        builder: (context, data, reload) {
          final task = data.map;
          final status = task['status'] as String? ?? '';
          final version = task['version'] as int?;
          final workItem = task['workItem'].map;
          Future<void> run(Future<Object?> Function(String p) action) =>
              act(context, () => action(state.propertyId!), reload);
          final accept = state.can('task.accept');
          final complete = state.can('task.complete');
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsetsDirectional.all(16),
            children: [
              Text(
                task['title'] as String? ?? '',
                key: const Key('task-title'),
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  Chip(key: const Key('task-status'), label: Text(t.taskStatus(status))),
                  Chip(label: Text(t.taskPriority(task['priority'] as String? ?? ''))),
                  if (task['dueAt'] != null) Chip(label: Text(t.taskDue(formatMoment(context, task['dueAt'] as String?)))),
                ],
              ),
              if (workItem['title'] != null && workItem['title'] != task['title']) ...[
                const SizedBox(height: 8),
                Text(t.taskPartOf(workItem['title']! as String)),
              ],
              if (task['pauseReason'] != null && status == 'PAUSED') ...[
                const SizedBox(height: 8),
                Text(task['pauseReason']! as String),
              ],
              const SizedBox(height: 24),
              if (accept && (status == 'ASSIGNED' || status == 'ACCEPTED'))
                FilledButton.icon(
                  key: const Key('task-start'),
                  icon: const Icon(Icons.play_arrow),
                  label: Text(t.taskStart),
                  onPressed: () =>
                      run((p) => state.api.startTask(p, taskId, TaskActionDto(expectedVersion: version))),
                ),
              if (accept && status == 'PAUSED')
                FilledButton.icon(
                  key: const Key('task-resume'),
                  icon: const Icon(Icons.play_arrow),
                  label: Text(t.taskResume),
                  onPressed: () =>
                      run((p) => state.api.resumeTask(p, taskId, TaskActionDto(expectedVersion: version))),
                ),
              if (complete && (status == 'ACCEPTED' || status == 'IN_PROGRESS' || status == 'PAUSED')) ...[
                const SizedBox(height: 8),
                FilledButton.tonalIcon(
                  key: const Key('task-complete'),
                  icon: const Icon(Icons.check),
                  label: Text(t.taskComplete),
                  onPressed: () =>
                      run((p) => state.api.completeTask(p, taskId, TaskActionDto(expectedVersion: version))),
                ),
              ],
              if (accept && status == 'IN_PROGRESS') ...[
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  key: const Key('task-pause'),
                  icon: const Icon(Icons.pause),
                  label: Text(t.taskPause),
                  onPressed: () async {
                    final reason = await askText(context, t.taskPauseReason);
                    if (reason == null || !context.mounted) return;
                    await run(
                      (p) => state.api.pauseTask(p, taskId, ReasonRequiredDto(reason: reason, expectedVersion: version)),
                    );
                  },
                ),
              ],
              if (accept && status == 'ASSIGNED') ...[
                const SizedBox(height: 8),
                TextButton(
                  key: const Key('task-reject'),
                  onPressed: () async {
                    final reason = await askText(context, t.taskRejectReason);
                    if (reason == null || !context.mounted) return;
                    await run(
                      (p) =>
                          state.api.rejectTask(p, taskId, ReasonRequiredDto(reason: reason, expectedVersion: version)),
                    );
                  },
                  child: Text(t.taskReject),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

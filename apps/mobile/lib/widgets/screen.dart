import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../l10n/app_localizations.dart';
import '../session.dart';
import 'common.dart';

/// A screen of the app: the title, the content and the Planova attribution under it (rule 15).
class AppScreen extends StatelessWidget {
  const AppScreen({super.key, required this.state, required this.title, required this.body, this.actions});
  final AppState state;
  final String title;
  final Widget body;
  final List<Widget>? actions;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title), actions: actions),
      body: SafeArea(bottom: false, child: body),
      bottomNavigationBar: SafeArea(child: PoweredBy(hotel: state.hotel)),
    );
  }
}

/// Loads a screen's data and shows it; pull down to refresh. Without a connection it shows what was saved, with a
/// line saying from when; with nothing saved, the error and a retry button.
class LoadView extends StatefulWidget {
  const LoadView({super.key, required this.load, required this.builder});
  final Future<Loaded> Function() load;
  final Widget Function(BuildContext context, Object? data, Future<void> Function() reload) builder;

  @override
  State<LoadView> createState() => LoadViewState();
}

class LoadViewState extends State<LoadView> {
  late Future<Loaded> _future = widget.load();

  Future<void> reload() async {
    final next = widget.load();
    setState(() {
      _future = next;
    });
    try {
      await next;
    } on Object {
      // Shown by the builder below.
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return FutureBuilder<Loaded>(
      future: _future,
      builder: (context, snapshot) {
        final loaded = snapshot.data;
        if (snapshot.hasError && snapshot.connectionState == ConnectionState.done) {
          return Center(
            child: Padding(
              padding: const EdgeInsetsDirectional.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(errorText(context, snapshot.error!), key: const Key('load-error'), textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  OutlinedButton(key: const Key('retry'), onPressed: reload, child: Text(t.commonRetry)),
                ],
              ),
            ),
          );
        }
        if (loaded == null) return const Center(child: CircularProgressIndicator());
        return Column(
          children: [
            if (loaded.savedAt != null)
              MaterialBanner(
                key: const Key('offline-banner'),
                content: Text(t.commonSavedAt(formatTime(context, loaded.savedAt!))),
                actions: [TextButton(onPressed: reload, child: Text(t.commonRetry))],
              ),
            Expanded(
              child: RefreshIndicator(onRefresh: reload, child: widget.builder(context, loaded.data, reload)),
            ),
          ],
        );
      },
    );
  }
}

/// An empty list that can still be pulled to refresh.
Widget emptyList(String text, {Key? key}) => ListView(
  physics: const AlwaysScrollableScrollPhysics(),
  children: [
    Padding(
      padding: const EdgeInsetsDirectional.all(32),
      child: Text(text, key: key, textAlign: TextAlign.center),
    ),
  ],
);

/// Runs an action the person asked for; a refusal or a lost connection is shown, and the screen reloads either way.
Future<void> act(BuildContext context, Future<Object?> Function() action, Future<void> Function() reload) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    await action();
  } on Object catch (e) {
    if (context.mounted) messenger.showSnackBar(SnackBar(content: Text(errorText(context, e))));
  }
  await reload();
}

/// Asks for a short reason (pausing, declining, how an alert was resolved); null when the person cancels.
Future<String?> askText(BuildContext context, String title) {
  final t = AppLocalizations.of(context);
  final controller = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: TextField(key: const Key('reason-field'), controller: controller, autofocus: true, maxLength: 500),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: Text(t.commonCancel)),
        FilledButton(
          key: const Key('reason-save'),
          onPressed: () {
            final text = controller.text.trim();
            if (text.isNotEmpty) Navigator.pop(context, text);
          },
          child: Text(t.commonSave),
        ),
      ],
    ),
  );
}

String _locale(BuildContext context) => Localizations.localeOf(context).languageCode;

/// A time of day in the person's language.
String formatTime(BuildContext context, DateTime at) => DateFormat.Hm(_locale(context)).format(at.toLocal());

/// A moment from the API (ISO 8601, UTC) as day and time in the person's language.
String formatMoment(BuildContext context, String? iso) {
  final at = iso == null ? null : DateTime.tryParse(iso);
  if (at == null) return '';
  return DateFormat.MMMd(_locale(context)).add_Hm().format(at.toLocal());
}

/// A calendar date (`YYYY-MM-DD`) in the person's language.
String formatDate(BuildContext context, String date) {
  final at = DateTime.tryParse(date);
  return at == null ? date : DateFormat.yMMMEd(_locale(context)).format(at);
}

/// JSON helpers for the API's answers (the OpenAPI document has no response schemas yet).
extension JsonRead on Object? {
  Map<String, Object?> get map => this is Map<String, Object?> ? this! as Map<String, Object?> : const {};
  List<Map<String, Object?>> get list =>
      this is List<Object?> ? (this! as List<Object?>).whereType<Map<String, Object?>>().toList() : const [];
}

import 'package:flutter/material.dart';

import '../api/transport.dart';
import '../l10n/app_localizations.dart';
import '../session.dart';
import '../widgets/common.dart';

/// First launch: the hotel code the manager gave (the code staff sign in with). The platform answers with the
/// hotel's brand only.
class HotelCodeScreen extends StatefulWidget {
  const HotelCodeScreen({super.key, required this.state});
  final AppState state;

  @override
  State<HotelCodeScreen> createState() => _HotelCodeScreenState();
}

class _HotelCodeScreenState extends State<HotelCodeScreen> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    final t = AppLocalizations.of(context);
    if (_code.text.trim().length < 2) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.state.findHotel(_code.text);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = e is ApiException && e.status == 404 ? t.hotelNotFound : errorText(context, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(t.appTitle),
        actions: [LanguageMenu(state: widget.state)],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsetsDirectional.all(24),
          children: [
            Text(t.hotelTitle, style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(t.hotelIntro),
            const SizedBox(height: 24),
            TextField(
              key: const Key('hotel-code'),
              controller: _code,
              textCapitalization: TextCapitalization.characters,
              autocorrect: false,
              decoration: InputDecoration(labelText: t.hotelCode, border: const OutlineInputBorder()),
              onSubmitted: (_) => _submit(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                key: const Key('error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
            const SizedBox(height: 16),
            FilledButton(key: const Key('continue'), onPressed: _busy ? null : _submit, child: Text(t.hotelContinue)),
            const PoweredBy(hotel: null),
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../api/transport.dart';
import '../l10n/app_localizations.dart';
import '../session.dart';
import '../widgets/common.dart';

/// Sign-in with the person's own account at this hotel (same IAM, MFA and sessions as the staff web).
class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, required this.state, required this.baseUrl});
  final AppState state;
  final String baseUrl;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _run(Future<void> Function() action) async {
    final t = AppLocalizations.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = e is ApiException && e.status == 401 ? t.signinFailed : errorText(context, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final state = widget.state;
    final hotel = state.hotel!;
    final mfa = state.mfaPending;
    return Scaffold(
      appBar: AppBar(
        title: Text(hotel.displayName, key: const Key('hotel-name')),
        actions: [LanguageMenu(state: state)],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsetsDirectional.all(24),
          children: [
            Center(
              child: HotelMark(hotel: hotel, baseUrl: widget.baseUrl, size: 72),
            ),
            const SizedBox(height: 16),
            Text(
              mfa ? t.signinMfaTitle : t.signinTitle(hotel.displayName),
              style: Theme.of(context).textTheme.titleLarge,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            if (!mfa) ...[
              TextField(
                key: const Key('email'),
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                decoration: InputDecoration(labelText: t.signinEmail, border: const OutlineInputBorder()),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('password'),
                controller: _password,
                obscureText: true,
                decoration: InputDecoration(labelText: t.signinPassword, border: const OutlineInputBorder()),
              ),
            ] else ...[
              Text(t.signinMfaHint),
              const SizedBox(height: 12),
              TextField(
                key: const Key('mfa-code'),
                controller: _code,
                keyboardType: TextInputType.number,
                maxLength: 6,
                decoration: InputDecoration(labelText: t.signinMfaTitle, border: const OutlineInputBorder()),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                key: const Key('error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
            const SizedBox(height: 16),
            FilledButton(
              key: const Key('sign-in'),
              onPressed: _busy
                  ? null
                  : () => _run(() async {
                      if (mfa) {
                        await state.verifyMfa(_code.text);
                      } else {
                        await state.signIn(_email.text, _password.text);
                      }
                    }),
              child: Text(mfa ? t.signinVerify : t.signinSubmit),
            ),
            TextButton(
              key: const Key('change-hotel'),
              onPressed: _busy ? null : state.forgetHotel,
              child: Text(t.hotelChange),
            ),
            PoweredBy(hotel: hotel),
          ],
        ),
      ),
    );
  }
}

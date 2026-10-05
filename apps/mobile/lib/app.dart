import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'l10n/app_localizations.dart';
import 'screens/home_screen.dart';
import 'screens/inbox_screen.dart';
import 'screens/hotel_code_screen.dart';
import 'screens/sign_in_screen.dart';
import 'session.dart';

/// The five languages of the platform (ADR-0022); Arabic is the only right-to-left one.
const supportedLocales = ['en', 'ar', 'it', 'ru', 'de'];

/// Each language by its own name, for the language menu.
const localeNames = {'en': 'English', 'ar': 'العربية', 'it': 'Italiano', 'ru': 'Русский', 'de': 'Deutsch'};

/// The Hotella staff app (ADR-0023): hotel code → the hotel's brand → sign-in → home. One app for every hotel; the
/// hotel's colour themes it after the code is known. A tapped notification opens its screen once someone is signed in.
class HotellaApp extends StatefulWidget {
  const HotellaApp({super.key, required this.state, required this.baseUrl});

  final AppState state;
  final String baseUrl;

  @override
  State<HotellaApp> createState() => _HotellaAppState();
}

class _HotellaAppState extends State<HotellaApp> {
  final _navigator = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_openTapped);
  }

  @override
  void dispose() {
    widget.state.removeListener(_openTapped);
    super.dispose();
  }

  void _openTapped() {
    if (!widget.state.hasOpening) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final navigator = _navigator.currentState;
      final target = navigator == null ? null : widget.state.takeOpening();
      if (target != null) openTarget(navigator!, widget.state, target);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final baseUrl = widget.baseUrl;
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        final seed = Color(state.hotel?.colorValue ?? 0xFF0F4C81);
        return MaterialApp(
          navigatorKey: _navigator,
          onGenerateTitle: (context) => AppLocalizations.of(context).appTitle,
          debugShowCheckedModeBanner: false,
          locale: Locale(state.locale),
          supportedLocales: [for (final l in supportedLocales) Locale(l)],
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          theme: ThemeData(colorSchemeSeed: seed, useMaterial3: true),
          home: !state.ready
              ? const Scaffold(body: Center(child: CircularProgressIndicator()))
              : state.hotel == null
              ? HotelCodeScreen(state: state)
              : state.signedIn
              ? HomeScreen(state: state, baseUrl: baseUrl)
              : SignInScreen(state: state, baseUrl: baseUrl),
        );
      },
    );
  }
}

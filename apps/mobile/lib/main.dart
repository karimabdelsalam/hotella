import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'api/transport.dart';
import 'app.dart';
import 'push.dart';
import 'session.dart';

/// The platform the app talks to, set per build: `flutter build … --dart-define=HOTELLA_API=https://…`.
const apiBase = String.fromEnvironment('HOTELLA_API', defaultValue: 'http://10.0.2.2:3000');

/// The build's version, shown to the platform with the phone's registration.
const appVersion = String.fromEnvironment('HOTELLA_APP_VERSION', defaultValue: '1.0.0');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final device = WidgetsBinding.instance.platformDispatcher.locale.languageCode;
  final state = AppState(
    transport: ApiTransport(baseUrl: apiBase, client: http.Client()),
    store: const SecureSessionStore(),
    locale: supportedLocales.contains(device) ? device : 'en',
    push: await FirebasePush.create(),
    appVersion: appVersion,
  );
  runApp(HotellaApp(state: state, baseUrl: apiBase));
  await state.restore();
}

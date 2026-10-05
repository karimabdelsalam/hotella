import 'dart:async';
import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

/// This phone's push address, as the platform registers it (`POST /me/devices`).
typedef PushAddress = ({String platform, String token});

/// Where the app gets its push address (ADR-0023). The platform sends through Firebase Cloud Messaging, which also
/// reaches iPhones through the APNs key in the Firebase project.
abstract class PushRegistrar {
  /// Asks the person once for permission and returns the address, or null (no permission, push not configured).
  Future<PushAddress?> address();

  /// A new address replaced the old one (the provider rotated it).
  Stream<PushAddress> get changes;

  /// Signing out: the address is deleted, so this phone never receives the next person's hotel work.
  Future<void> forget();

  /// The person tapped a notification while the app was in the background: its data (references only).
  Stream<Map<String, String>> get opened;

  /// The notification the app was started from, if any.
  Future<Map<String, String>?> launchedFrom();

  /// A notification arrived while the app was open (the inbox count is refreshed).
  Stream<void> get received;
}

/// A build without Firebase settings: the app works, nothing is pushed.
class NoPush implements PushRegistrar {
  const NoPush();
  @override
  Future<PushAddress?> address() async => null;
  @override
  Stream<PushAddress> get changes => const Stream.empty();
  @override
  Future<void> forget() async {}
  @override
  Stream<Map<String, String>> get opened => const Stream.empty();
  @override
  Future<Map<String, String>?> launchedFrom() async => null;
  @override
  Stream<void> get received => const Stream.empty();
}

/// Firebase settings are build-time values (`--dart-define=FIREBASE_…`, see apps/mobile/README.md): no
/// google-services.json or GoogleService-Info.plist in the repository.
class FirebasePush implements PushRegistrar {
  FirebasePush._();

  static const _projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
  static const _senderId = String.fromEnvironment('FIREBASE_SENDER_ID');
  static const _apiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const _appId = String.fromEnvironment('FIREBASE_APP_ID');

  /// Firebase when the build carries its settings, otherwise [NoPush].
  static Future<PushRegistrar> create() async {
    if (_projectId.isEmpty || _senderId.isEmpty || _apiKey.isEmpty || _appId.isEmpty) return const NoPush();
    try {
      await Firebase.initializeApp(
        options: const FirebaseOptions(
          apiKey: _apiKey,
          appId: _appId,
          messagingSenderId: _senderId,
          projectId: _projectId,
        ),
      );
      return FirebasePush._();
    } on Object {
      return const NoPush();
    }
  }

  String get _platform => Platform.isIOS ? 'IOS' : 'ANDROID';

  @override
  Future<PushAddress?> address() async {
    final messaging = FirebaseMessaging.instance;
    final permission = await messaging.requestPermission();
    if (permission.authorizationStatus == AuthorizationStatus.denied) return null;
    final token = await messaging.getToken();
    return token == null ? null : (platform: _platform, token: token);
  }

  @override
  Stream<PushAddress> get changes =>
      FirebaseMessaging.instance.onTokenRefresh.map((token) => (platform: _platform, token: token));

  @override
  Future<void> forget() => FirebaseMessaging.instance.deleteToken();

  @override
  Stream<Map<String, String>> get opened => FirebaseMessaging.onMessageOpenedApp.map(_data);

  @override
  Future<Map<String, String>?> launchedFrom() async {
    final message = await FirebaseMessaging.instance.getInitialMessage();
    return message == null ? null : _data(message);
  }

  @override
  Stream<void> get received => FirebaseMessaging.onMessage.map((_) {});

  static Map<String, String> _data(RemoteMessage message) => {
    for (final e in message.data.entries) e.key: '${e.value}',
  };
}

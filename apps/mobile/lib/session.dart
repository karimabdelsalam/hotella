import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api/hotella_api.g.dart';
import 'api/transport.dart';

/// The hotel a code resolved to: its brand as the app shows it (rule 15), never staff or guest data.
@immutable
class Hotel {
  const Hotel({
    required this.code,
    required this.propertyId,
    required this.displayName,
    required this.primaryColor,
    required this.hasLogo,
    required this.attributionLabel,
    required this.attributionHref,
    required this.showAttribution,
  });

  factory Hotel.fromJson(Map<String, Object?> json) {
    final attribution = (json['attribution'] as Map<String, Object?>?) ?? const {};
    return Hotel(
      code: json['code']! as String,
      propertyId: json['propertyId']! as String,
      displayName: json['displayName']! as String,
      primaryColor: json['primaryColor'] as String? ?? '#0F4C81',
      hasLogo: json['hasLogo'] as bool? ?? false,
      // The Planova attribution is the platform's, not the brand's: it always has a label.
      attributionLabel: attribution['label'] as String? ?? 'Powered by Planova',
      attributionHref: attribution['href'] as String? ?? 'https://planova.com.eg',
      showAttribution: attribution['show'] as bool? ?? true,
    );
  }

  final String code;
  final String propertyId;
  final String displayName;
  final String primaryColor;
  final bool hasLogo;
  final String attributionLabel;
  final String attributionHref;
  final bool showAttribution;

  Map<String, Object?> toJson() => {
    'code': code,
    'propertyId': propertyId,
    'displayName': displayName,
    'primaryColor': primaryColor,
    'hasLogo': hasLogo,
    'attribution': {'label': attributionLabel, 'href': attributionHref, 'show': showAttribution},
  };

  /// `#RRGGBB` → ARGB.
  int get colorValue {
    final hex = primaryColor.replaceFirst('#', '');
    return int.tryParse('FF$hex', radix: 16) ?? 0xFF0F4C81;
  }
}

/// A property the person works at and what they may do there.
@immutable
class Membership {
  const Membership(this.propertyId, this.permissions);
  final String? propertyId;
  final Set<String> permissions;
}

/// Who signed in (from `GET /me`).
@immutable
class StaffMember {
  const StaffMember({required this.givenName, required this.memberships});

  factory StaffMember.fromJson(Map<String, Object?> json) {
    final user = json['user']! as Map<String, Object?>;
    final memberships = (json['memberships'] as List<Object?>? ?? const [])
        .cast<Map<String, Object?>>()
        .map(
          (m) => Membership(
            m['propertyId'] as String?,
            (m['permissions'] as List<Object?>? ?? const []).cast<String>().toSet(),
          ),
        )
        .toList();
    return StaffMember(givenName: user['givenName'] as String?, memberships: memberships);
  }

  final String? givenName;
  final List<Membership> memberships;

  /// Permissions at a property (a tenant-wide membership counts everywhere).
  Set<String> permissionsAt(String propertyId) => {
    for (final m in memberships)
      if (m.propertyId == null || m.propertyId == propertyId) ...m.permissions,
  };
}

/// Where the hotel, tokens and language are kept between launches: the Keychain (iOS) or Keystore (Android).
abstract class SessionStore {
  Future<String?> read(String key);
  Future<void> write(String key, String? value);
}

class SecureSessionStore implements SessionStore {
  const SecureSessionStore();
  static const _storage = FlutterSecureStorage();
  @override
  Future<String?> read(String key) => _storage.read(key: key);
  @override
  Future<void> write(String key, String? value) =>
      value == null ? _storage.delete(key: key) : _storage.write(key: key, value: value);
}

/// For tests and previews.
class MemorySessionStore implements SessionStore {
  final Map<String, String> values = {};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String? value) async => value == null ? values.remove(key) : values[key] = value;
}

enum SignInResult { signedIn, mfaRequired }

/// The app's state: the hotel, the session and the person. Screens read it and call its actions; the API decides.
class AppState extends ChangeNotifier implements TokenSource {
  AppState({required this.transport, required this.store, required String locale}) : _locale = locale {
    transport
      ..tokens = this
      ..locale = locale;
    api = HotellaApi(transport);
  }

  final ApiTransport transport;
  final SessionStore store;
  late final HotellaApi api;

  String _locale;
  Hotel? hotel;
  StaffMember? me;
  String? _access;
  String? _refresh;
  String? _challenge;
  String? propertyId;
  List<({String id, String name})> properties = const [];
  bool ready = false;

  String get locale => _locale;
  @override
  String? get accessToken => _access;
  bool get signedIn => me != null;
  bool get mfaPending => _challenge != null;

  /// Restores what the last launch left (hotel, tokens, language).
  Future<void> restore() async {
    final hotelJson = await store.read('hotel');
    if (hotelJson != null) hotel = Hotel.fromJson(jsonDecode(hotelJson) as Map<String, Object?>);
    _locale = await store.read('locale') ?? _locale;
    transport.locale = _locale;
    _refresh = await store.read('refresh');
    if (_refresh != null && await renew()) {
      try {
        await _loadMe();
      } on ApiException {
        await _clearSession();
      }
    }
    ready = true;
    notifyListeners();
  }

  Future<void> setLocale(String locale) async {
    _locale = locale;
    transport.locale = locale;
    await store.write('locale', locale);
    notifyListeners();
  }

  Future<void> findHotel(String code) async {
    final json = await api.findHotel(code.trim().toUpperCase()) as Map<String, Object?>;
    hotel = Hotel.fromJson(json);
    await store.write('hotel', jsonEncode(hotel!.toJson()));
    notifyListeners();
  }

  Future<void> forgetHotel() async {
    await signOut();
    hotel = null;
    await store.write('hotel', null);
    notifyListeners();
  }

  Future<SignInResult> signIn(String email, String password) async {
    final json = await api.login(
      LoginDto(tenantCode: hotel!.code, email: email.trim(), password: password),
    ) as Map<String, Object?>;
    if (json['mfaRequired'] == true) {
      _challenge = json['challengeToken'] as String?;
      notifyListeners();
      return SignInResult.mfaRequired;
    }
    await _opened(json);
    return SignInResult.signedIn;
  }

  Future<void> verifyMfa(String code) async {
    final json =
        await api.verifyMfa(MfaVerifyDto(challengeToken: _challenge!, code: code.trim())) as Map<String, Object?>;
    _challenge = null;
    await _opened(json);
  }

  Future<void> signOut() async {
    if (_access != null) {
      try {
        await api.logout();
      } on ApiException {
        // The session ends on this device either way.
      }
    }
    await _clearSession();
    notifyListeners();
  }

  void selectProperty(String id) {
    propertyId = id;
    notifyListeners();
  }

  @override
  Future<bool> renew() async {
    final refresh = _refresh;
    if (refresh == null) return false;
    try {
      final json = await api.refresh(RefreshDto(refreshToken: refresh)) as Map<String, Object?>;
      await _keep(json);
      return true;
    } on ApiException catch (e) {
      if (!e.offline) await _clearSession();
      return false;
    }
  }

  Future<void> _opened(Map<String, Object?> tokens) async {
    await _keep(tokens);
    await _loadMe();
    notifyListeners();
  }

  Future<void> _keep(Map<String, Object?> tokens) async {
    _access = tokens['accessToken'] as String?;
    _refresh = tokens['refreshToken'] as String?;
    await store.write('refresh', _refresh);
  }

  Future<void> _loadMe() async {
    me = StaffMember.fromJson(await api.me() as Map<String, Object?>);
    final list = (await api.listProperties() as List<Object?>? ?? const []).cast<Map<String, Object?>>();
    properties = [for (final p in list) (id: p['id']! as String, name: p['name']! as String)];
    if (propertyId == null || !properties.any((p) => p.id == propertyId)) {
      propertyId = properties.any((p) => p.id == hotel?.propertyId)
          ? hotel!.propertyId
          : (properties.isEmpty ? null : properties.first.id);
    }
  }

  Future<void> _clearSession() async {
    _access = null;
    _refresh = null;
    _challenge = null;
    me = null;
    properties = const [];
    propertyId = null;
    await store.write('refresh', null);
  }
}

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hotella/api/transport.dart';
import 'package:hotella/app.dart';
import 'package:hotella/push.dart';
import 'package:hotella/session.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const base = 'https://api.example.test';
const property = '01900000-0000-7000-8000-000000000001';

/// The platform as the app sees it: a hotel `NILE`, one staff member, MFA for `mfa@nile.test`.
class FakeApi {
  final calls = <String>[];
  final bodies = <String, Object?>{};

  late final client = MockClient((request) async {
    final path = request.url.path.replaceFirst('/api/v1', '');
    calls.add('${request.method} $path ${request.headers['accept-language']}');
    if (request.body.isNotEmpty) bodies[path] = jsonDecode(request.body);
    http.Response json(Object body, [int status = 200]) =>
        http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});
    switch (path) {
      case '/public/hotels/NILE':
        return json({
          'code': 'NILE',
          'propertyId': property,
          'displayName': 'Nile Palace',
          'primaryColor': '#0B3D91',
          'secondaryColor': '#FFFFFF',
          'hasLogo': false,
          'locale': 'en',
          'direction': 'ltr',
          'attribution': {'show': true, 'label': 'Powered by Planova', 'href': 'https://planova.com.eg'},
        });
      case '/auth/login':
        final body = jsonDecode(request.body) as Map<String, Object?>;
        if (body['password'] != 'right') {
          return json({'code': 'iam.auth.invalid_credentials', 'detail': 'Wrong.'}, 401);
        }
        if (body['email'] == 'mfa@nile.test') return json({'mfaRequired': true, 'challengeToken': 'challenge-0123'});
        return json(tokens);
      case '/auth/mfa/verify':
      case '/auth/refresh':
        return json(tokens);
      case '/me':
        if (request.headers['authorization'] != 'Bearer access-1') return json({'code': 'platform.unauthorized'}, 401);
        return json({
          'user': {'id': 'u1', 'givenName': 'Mona'},
          'permissions': <String>[],
          'memberships': [
            {
              'propertyId': property,
              'permissions': ['task.read', 'restaurant.reservation.read'],
            },
          ],
        });
      case '/properties':
        return json([
          {'id': property, 'name': 'Nile Palace Cairo'},
        ]);
      case '/auth/logout':
        return http.Response('', 204);
      case '/me/devices':
        return json({'id': 'dev-1', 'platform': 'ANDROID'});
      case '/me/devices/dev-1':
        return http.Response('', 204);
    }
    return json({'code': 'platform.not_found', 'detail': 'Not found.'}, 404);
  });

  static const tokens = {
    'accessToken': 'access-1',
    'tokenType': 'Bearer',
    'expiresIn': 900,
    'refreshToken': 'refresh-0123456789',
    'refreshExpiresAt': '2030-01-01T00:00:00Z',
    'sessionId': 's1',
  };
}

/// A phone that agreed to notifications; records when the app forgets its address.
class FakePush implements PushRegistrar {
  bool forgotten = false;
  @override
  Future<PushAddress?> address() async => (platform: 'ANDROID', token: 'fcm-token-0123456789-abcdefghij');
  @override
  Stream<PushAddress> get changes => const Stream.empty();
  @override
  Future<void> forget() async => forgotten = true;
}

Future<(AppState, FakeApi, MemorySessionStore)> start(
  WidgetTester tester, {
  String locale = 'en',
  PushRegistrar push = const NoPush(),
}) async {
  final api = FakeApi();
  final store = MemorySessionStore();
  final state = AppState(
    transport: ApiTransport(baseUrl: base, client: api.client),
    store: store,
    locale: locale,
    push: push,
    appVersion: '1.0.0',
  );
  await tester.pumpWidget(HotellaApp(state: state, baseUrl: base));
  await state.restore();
  await tester.pumpAndSettle();
  return (state, api, store);
}

void main() {
  testWidgets('hotel code → the hotel\'s brand → sign-in → home with the sections the person may open', (tester) async {
    final (state, api, store) = await start(tester);
    expect(find.text('Your hotel'), findsOneWidget);
    expect(find.byKey(const Key('powered-by')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('hotel-code')), 'nope');
    await tester.tap(find.byKey(const Key('continue')));
    await tester.pumpAndSettle();
    expect(find.text('No hotel uses this code. Check it with your manager.'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('hotel-code')), 'nile');
    await tester.tap(find.byKey(const Key('continue')));
    await tester.pumpAndSettle();
    expect(find.text('Sign in to Nile Palace'), findsOneWidget);
    expect(store.values['hotel'], contains('"code":"NILE"'));

    await tester.enterText(find.byKey(const Key('email')), 'mona@nile.test');
    await tester.enterText(find.byKey(const Key('password')), 'wrong');
    await tester.tap(find.byKey(const Key('sign-in')));
    await tester.pumpAndSettle();
    expect(find.text('The e-mail or password is not right.'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('password')), 'right');
    await tester.tap(find.byKey(const Key('sign-in')));
    await tester.pumpAndSettle();
    expect(api.bodies['/auth/login'], {'tenantCode': 'NILE', 'email': 'mona@nile.test', 'password': 'right'});
    expect(find.text('Hello, Mona'), findsOneWidget);
    expect(find.text('2 things you can do here'), findsOneWidget);
    expect(find.byKey(const Key('section-tasks')), findsOneWidget);
    expect(find.byKey(const Key('section-restaurant')), findsOneWidget);
    expect(find.byKey(const Key('section-alerts')), findsNothing);
    expect(find.byKey(const Key('powered-by')), findsOneWidget);
    // Only the refresh token is kept, in the secure store; the access token stays in memory.
    expect(store.values['refresh'], 'refresh-0123456789');
    expect(store.values.values.any((v) => v.contains('access-1')), isFalse);

    await tester.tap(find.byKey(const Key('sign-out')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('POST /auth/logout en'));
    expect(store.values.containsKey('refresh'), isFalse);
    expect(find.text('Sign in to Nile Palace'), findsOneWidget);
  });

  testWidgets('after sign-in the phone registers for pushes; sign-out removes it before the session ends', (
    tester,
  ) async {
    final push = FakePush();
    final (state, api, _) = await start(tester, push: push);
    await tester.enterText(find.byKey(const Key('hotel-code')), 'NILE');
    await tester.tap(find.byKey(const Key('continue')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('email')), 'mona@nile.test');
    await tester.enterText(find.byKey(const Key('password')), 'right');
    await tester.tap(find.byKey(const Key('sign-in')));
    await tester.pumpAndSettle();
    expect(api.bodies['/me/devices'], {
      'platform': 'ANDROID',
      'pushToken': 'fcm-token-0123456789-abcdefghij',
      'appVersion': '1.0.0',
      'locale': 'en',
    });
    expect(state.deviceId, 'dev-1');

    await tester.tap(find.byKey(const Key('sign-out')));
    await tester.pumpAndSettle();
    final revoke = api.calls.indexOf('DELETE /me/devices/dev-1 en');
    expect(revoke, greaterThan(-1));
    expect(revoke, lessThan(api.calls.indexOf('POST /auth/logout en')));
    expect(push.forgotten, isTrue);
    expect(state.deviceId, isNull);
  });

  testWidgets('a person with MFA enters the code after the password', (tester) async {
    final (_, api, _) = await start(tester);
    await tester.enterText(find.byKey(const Key('hotel-code')), 'NILE');
    await tester.tap(find.byKey(const Key('continue')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('email')), 'mfa@nile.test');
    await tester.enterText(find.byKey(const Key('password')), 'right');
    await tester.tap(find.byKey(const Key('sign-in')));
    await tester.pumpAndSettle();
    expect(find.text('Enter the 6-digit code from your authenticator app.'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('mfa-code')), '123456');
    await tester.tap(find.byKey(const Key('sign-in')));
    await tester.pumpAndSettle();
    expect(api.bodies['/auth/mfa/verify'], {'challengeToken': 'challenge-0123', 'code': '123456'});
    expect(find.text('Hello, Mona'), findsOneWidget);
  });

  testWidgets('in Arabic the app is right-to-left and asks the API in Arabic', (tester) async {
    final (_, api, _) = await start(tester, locale: 'ar');
    expect(find.text('فندقك'), findsOneWidget);
    final direction = Directionality.of(tester.element(find.byKey(const Key('hotel-code'))));
    expect(direction, TextDirection.rtl);
    await tester.enterText(find.byKey(const Key('hotel-code')), 'NILE');
    await tester.tap(find.byKey(const Key('continue')));
    await tester.pumpAndSettle();
    expect(api.calls.first, 'GET /public/hotels/NILE ar');
    expect(find.text('تسجيل الدخول إلى Nile Palace'), findsOneWidget);
  });

  for (final (locale, title) in [('it', 'Il tuo hotel'), ('ru', 'Ваш отель'), ('de', 'Ihr Hotel')]) {
    testWidgets('the first screen in $locale is left-to-right', (tester) async {
      await start(tester, locale: locale);
      expect(find.text(title), findsOneWidget);
      expect(Directionality.of(tester.element(find.byKey(const Key('hotel-code')))), TextDirection.ltr);
    });
  }

  testWidgets('a returning person is signed in again from the kept refresh token', (tester) async {
    final api = FakeApi();
    final store = MemorySessionStore()
      ..values['hotel'] = jsonEncode({
        'code': 'NILE',
        'propertyId': property,
        'displayName': 'Nile Palace',
        'primaryColor': '#0B3D91',
        'hasLogo': false,
        'attribution': {'label': 'Powered by Planova', 'href': 'https://planova.com.eg', 'show': true},
      })
      ..values['refresh'] = 'refresh-0123456789';
    final state = AppState(
      transport: ApiTransport(baseUrl: base, client: api.client),
      store: store,
      locale: 'en',
    );
    await tester.pumpWidget(HotellaApp(state: state, baseUrl: base));
    await state.restore();
    await tester.pumpAndSettle();
    expect(find.text('Hello, Mona'), findsOneWidget);
    expect(api.calls.first, 'POST /auth/refresh en');
  });
}

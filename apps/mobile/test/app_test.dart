import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hotella/api/transport.dart';
import 'package:hotella/app.dart';
import 'package:hotella/l10n/app_localizations.dart';
import 'package:hotella/push.dart';
import 'package:hotella/screens/restaurant_screen.dart';
import 'package:hotella/session.dart';
import 'package:hotella/widgets/screen.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const base = 'https://api.example.test';
const property = '01900000-0000-7000-8000-000000000001';

const p = '/properties/$property';

/// The platform as the app sees it: a hotel `NILE`, one staff member, MFA for `mfa@nile.test`, a task, an alert, a
/// dinner booking and two notifications. [offline] makes every call fail as without a connection.
class FakeApi {
  FakeApi({this.permissions = const ['task.read', 'restaurant.reservation.read']});
  final List<String> permissions;
  final calls = <String>[];
  final bodies = <String, Object?>{};
  bool offline = false;

  final task = <String, Object?>{
    'id': 't1',
    'title': 'Fix the air conditioning in 204',
    'status': 'ASSIGNED',
    'priority': 'HIGH',
    'dueAt': null,
    'version': 1,
    'workItem': {'id': 'w1', 'title': 'Fix the air conditioning in 204'},
  };
  final alert = <String, Object?>{
    'id': 'a1',
    'type': 'SLA_RESPONSE_BREACHED',
    'severity': 'WARNING',
    'status': 'OPEN',
    'subject': {'type': 'work_item', 'id': 'w1'},
    'occurrences': 3,
    'lastSeenAt': '2026-10-05T09:30:00Z',
    'version': 1,
  };
  final booking = <String, Object?>{
    'id': 'r1',
    'restaurantId': 'rest-1',
    'sittingId': 's1',
    'serviceDate': '2026-10-08',
    'startsAt': '20:30',
    'partySize': 2,
    'roomNumber': '102',
    'guestName': 'Giulia Rossi',
    'status': 'CONFIRMED',
    'notes': 'nut allergy',
    'version': 1,
    'restaurantName': 'La Terrazza',
  };
  final notifications = <Map<String, Object?>>[
    {
      'id': 'n1',
      'title': 'New restaurant booking',
      'body': 'A table for 2 guests on 2026-10-08 at 20:30 was booked from the guest app.',
      'source': {'type': 'restaurant_reservation', 'id': 'r1'},
      'createdAt': '2026-10-05T09:00:00Z',
      'readAt': null,
    },
    {
      'id': 'n2',
      'title': 'New task for you',
      'body': 'A task was assigned to you.',
      'source': {'type': 'task', 'id': 't1'},
      'createdAt': '2026-10-05T08:00:00Z',
      'readAt': '2026-10-05T08:05:00Z',
    },
  ];

  static const _taskMoves = {
    'start': 'IN_PROGRESS',
    'pause': 'PAUSED',
    'resume': 'IN_PROGRESS',
    'complete': 'DONE',
    'reject': 'NEW',
  };
  static const _bookingMoves = {'seat': 'SEATED', 'complete': 'COMPLETED', 'no-show': 'NO_SHOW'};

  late final client = MockClient((request) async {
    final path = request.url.path.replaceFirst('/api/v1', '');
    final query = request.url.query.isEmpty ? '' : '?${request.url.query}';
    calls.add('${request.method} $path$query ${request.headers['accept-language']}');
    if (offline) throw http.ClientException('no route to host');
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
              'permissions': permissions,
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
      case '$p/tasks':
        final open = (request.url.queryParameters['status'] ?? '').split(',').contains(task['status']);
        return json({
          'items': [if (open) task],
          'next': null,
        });
      case '$p/tasks/t1':
        return json(task);
      case '$p/work-items/w1':
        return json({
          'id': 'w1',
          'title': task['title'],
          'status': 'OPEN',
          'priority': 'HIGH',
          'tasks': [task],
        });
      case '$p/alerts':
        return json([if (alert['status'] != 'RESOLVED') alert]);
      case '$p/alerts/a1/acknowledge':
        alert['status'] = 'ACKNOWLEDGED';
        return json(alert);
      case '$p/alerts/a1/resolve':
        alert['status'] = 'RESOLVED';
        return json(alert);
      case '$p/restaurant-reservations':
        final day = request.url.queryParameters['date'] == booking['serviceDate'];
        return json([
          {
            'id': 'rest-1',
            'name': 'La Terrazza',
            'sittings': [
              {
                'sittingId': 's1',
                'startsAt': '20:30',
                'seats': 20,
                'booked': day ? 2 : 0,
                'free': day ? 18 : 20,
                'reservations': [if (day) booking],
              },
            ],
          },
        ]);
      case '$p/restaurant-reservations/r1':
        return json(booking);
      case '$p/notifications':
        final unread = request.url.queryParameters['unread'] == 'true';
        return json([for (final n in notifications) if (!unread || n['readAt'] == null) n]);
    }
    final taskMove = RegExp('^$p/tasks/t1/(\\w+)\$').firstMatch(path);
    if (taskMove != null && _taskMoves.containsKey(taskMove[1])) {
      task['status'] = _taskMoves[taskMove[1]];
      task['version'] = (task['version']! as int) + 1;
      return json(task);
    }
    final bookingMove = RegExp('^$p/restaurant-reservations/r1/([\\w-]+)\$').firstMatch(path);
    if (bookingMove != null && _bookingMoves.containsKey(bookingMove[1])) {
      booking['status'] = _bookingMoves[bookingMove[1]];
      booking['version'] = (booking['version']! as int) + 1;
      return json(booking);
    }
    final read = RegExp('^$p/notifications/(\\w+)/read\$').firstMatch(path);
    if (read != null) {
      for (final n in notifications) {
        if (n['id'] == read[1]) n['readAt'] = '2026-10-05T10:00:00Z';
      }
      return json({'id': read[1], 'read': true});
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

/// A phone that agreed to notifications; records when the app forgets its address; [tap] is a notification tapped
/// in the background, [launch] the one the app was started from.
class FakePush implements PushRegistrar {
  FakePush({this.launch});
  bool forgotten = false;
  final Map<String, String>? launch;
  final _opened = StreamController<Map<String, String>>.broadcast();
  final _received = StreamController<void>.broadcast();
  void tap(Map<String, String> data) => _opened.add(data);
  void arrive() => _received.add(null);
  @override
  Future<PushAddress?> address() async => (platform: 'ANDROID', token: 'fcm-token-0123456789-abcdefghij');
  @override
  Stream<PushAddress> get changes => const Stream.empty();
  @override
  Future<void> forget() async => forgotten = true;
  @override
  Stream<Map<String, String>> get opened => _opened.stream;
  @override
  Future<Map<String, String>?> launchedFrom() async => launch;
  @override
  Stream<void> get received => _received.stream;
}

/// Everything a staff member of the app's screens may do.
const staffPermissions = [
  'task.read',
  'task.accept',
  'task.complete',
  'request.read',
  'alert.read',
  'alert.ack',
  'notification.read',
  'restaurant.reservation.read',
  'restaurant.reservation.manage',
];

Future<(AppState, FakeApi, MemorySessionStore)> start(
  WidgetTester tester, {
  String locale = 'en',
  PushRegistrar push = const NoPush(),
  FakeApi? api,
}) async {
  api ??= FakeApi();
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

/// Hotel code and sign-in as Mona (no MFA).
Future<void> signIn(WidgetTester tester) async {
  await tester.enterText(find.byKey(const Key('hotel-code')), 'NILE');
  await tester.tap(find.byKey(const Key('continue')));
  await tester.pumpAndSettle();
  await tester.enterText(find.byKey(const Key('email')), 'mona@nile.test');
  await tester.enterText(find.byKey(const Key('password')), 'right');
  await tester.tap(find.byKey(const Key('sign-in')));
  await tester.pumpAndSettle();
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

  testWidgets('my tasks: start, pause with a reason, resume and finish, each with the version the person saw', (
    tester,
  ) async {
    final api = FakeApi(permissions: staffPermissions);
    await start(tester, api: api);
    await signIn(tester);
    expect(find.text('4 things you can do here'), findsOneWidget);
    await tester.tap(find.byKey(const Key('section-tasks')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('GET $p/tasks?assignee=me&status=ASSIGNED%2CACCEPTED%2CIN_PROGRESS%2CPAUSED&limit=100 en'));
    expect(find.text('Fix the air conditioning in 204'), findsOneWidget);
    expect(find.text('Assigned to you · High priority'), findsOneWidget);
    expect(find.byKey(const Key('powered-by')), findsOneWidget);

    await tester.tap(find.byKey(const Key('task-t1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('task-reject')), findsOneWidget);
    await tester.tap(find.byKey(const Key('task-start')));
    await tester.pumpAndSettle();
    expect(api.bodies['$p/tasks/t1/start'], {'expectedVersion': 1});
    expect(find.descendant(of: find.byKey(const Key('task-status')), matching: find.text('In progress')), findsOneWidget);

    await tester.tap(find.byKey(const Key('task-pause')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('reason-field')), 'Waiting for a spare part');
    await tester.tap(find.byKey(const Key('reason-save')));
    await tester.pumpAndSettle();
    expect(api.bodies['$p/tasks/t1/pause'], {'reason': 'Waiting for a spare part', 'expectedVersion': 2});

    await tester.tap(find.byKey(const Key('task-resume')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('task-complete')));
    await tester.pumpAndSettle();
    expect(api.bodies['$p/tasks/t1/complete'], {'expectedVersion': 4});
    expect(find.descendant(of: find.byKey(const Key('task-status')), matching: find.text('Done')), findsOneWidget);
    expect(find.byKey(const Key('task-complete')), findsNothing);

    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('tasks-empty')), findsOneWidget);
  });

  testWidgets('without a connection a screen shows what was saved, and sign-out wipes it', (tester) async {
    final api = FakeApi(permissions: staffPermissions);
    final (state, _, store) = await start(tester, api: api);
    await signIn(tester);
    await tester.tap(find.byKey(const Key('section-tasks')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('offline-banner')), findsNothing);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(store.values.keys.where((k) => k.startsWith('cache.')), isNotEmpty);

    api.offline = true;
    await tester.tap(find.byKey(const Key('section-tasks')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('offline-banner')), findsOneWidget);
    expect(find.text('Fix the air conditioning in 204'), findsOneWidget);

    // Nothing saved for alerts yet: the error and a way to retry.
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('section-alerts')));
    await tester.pumpAndSettle();
    expect(find.text('No connection. Try again when you are back online.'), findsOneWidget);
    api.offline = false;
    await tester.tap(find.byKey(const Key('retry')));
    await tester.pumpAndSettle();
    expect(find.text('Work not picked up'), findsOneWidget);

    await tester.pageBack();
    await tester.pumpAndSettle();
    await state.signOut();
    await tester.pumpAndSettle();
    expect(store.values.keys.where((k) => k.startsWith('cache.')), isEmpty);
  });

  testWidgets('alerts: acknowledge, then resolve with what was done', (tester) async {
    final api = FakeApi(permissions: staffPermissions);
    await start(tester, api: api);
    await signIn(tester);
    await tester.tap(find.byKey(const Key('section-alerts')));
    await tester.pumpAndSettle();
    expect(find.text('Warning · Open · Seen 3 times · Last seen ${_moment(tester, '2026-10-05T09:30:00Z')}'), findsOneWidget);
    await tester.tap(find.byKey(const Key('alert-ack-a1')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('POST $p/alerts/a1/acknowledge en'));
    expect(find.byKey(const Key('alert-ack-a1')), findsNothing);
    await tester.tap(find.byKey(const Key('alert-resolve-a1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('reason-field')), 'Engineer on the way');
    await tester.tap(find.byKey(const Key('reason-save')));
    await tester.pumpAndSettle();
    expect(api.bodies['$p/alerts/a1/resolve'], {'resolution': 'Engineer on the way'});
    expect(find.byKey(const Key('alerts-empty')), findsOneWidget);
  });

  testWidgets('a tapped push for a new booking opens it; the waiter seats the guests', (tester) async {
    final api = FakeApi(permissions: staffPermissions);
    final push = FakePush();
    await start(tester, api: api, push: push);
    await signIn(tester);
    expect(find.byKey(const Key('unread')), findsOneWidget);
    expect(find.text('1'), findsOneWidget);

    push.tap({
      'intent_id': 'i1',
      'category': 'RESTAURANT',
      'property_id': property,
      'source_type': 'restaurant_reservation',
      'source_id': 'r1',
    });
    await tester.pumpAndSettle();
    expect(find.text('La Terrazza'), findsOneWidget);
    expect(find.byKey(const Key('reservation-guest')), findsOneWidget);
    expect(find.text('nut allergy'), findsOneWidget);
    await tester.tap(find.byKey(const Key('reservation-seat')));
    await tester.pumpAndSettle();
    expect(api.bodies['$p/restaurant-reservations/r1/seat'], {'version': 1});
    expect(
      find.descendant(of: find.byKey(const Key('reservation-status')), matching: find.text('Seated')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('reservation-complete')), findsOneWidget);
  });

  testWidgets('the app started from a push opens the task once the person is signed in again', (tester) async {
    final api = FakeApi(permissions: staffPermissions);
    final store = MemorySessionStore()
      ..values['hotel'] = jsonEncode({'code': 'NILE', 'propertyId': property, 'displayName': 'Nile Palace'})
      ..values['refresh'] = 'refresh-0123456789';
    final state = AppState(
      transport: ApiTransport(baseUrl: base, client: api.client),
      store: store,
      locale: 'en',
      push: FakePush(launch: {'property_id': property, 'source_type': 'task', 'source_id': 't1'}),
    );
    await tester.pumpWidget(HotellaApp(state: state, baseUrl: base));
    await state.restore();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('task-title')), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('Hello, Mona'), findsOneWidget);
  });

  testWidgets('the inbox marks a notification read and opens what it is about', (tester) async {
    final api = FakeApi(permissions: staffPermissions);
    await start(tester, api: api);
    await signIn(tester);
    await tester.tap(find.byKey(const Key('inbox')));
    await tester.pumpAndSettle();
    expect(find.text('New restaurant booking'), findsOneWidget);
    await tester.tap(find.byKey(const Key('notification-n1')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('POST $p/notifications/n1/read en'));
    expect(find.byKey(const Key('reservation-when')), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('unread')), findsNothing);
  });

  testWidgets('the restaurant board moves by day; empty days say so', (tester) async {
    final api = FakeApi(permissions: staffPermissions);
    final (state, _, _) = await start(tester, api: api);
    await signIn(tester);
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: RestaurantScreen(state: state, today: DateTime(2026, 10, 7)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('restaurant-empty')), findsOneWidget);
    await tester.tap(find.byKey(const Key('day-next')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('GET $p/restaurant-reservations?date=2026-10-08 en'));
    expect(find.text('20 seats').evaluate().isEmpty, isTrue);
    expect(find.text('2 of 20 seats booked'), findsOneWidget);
    expect(find.text('Room 102 · Giulia Rossi'), findsOneWidget);
    expect(find.text('2 guests · Confirmed'), findsOneWidget);
  });

  testWidgets('in Arabic the screens are right-to-left with Arabic labels', (tester) async {
    final api = FakeApi(permissions: staffPermissions);
    await start(tester, api: api, locale: 'ar');
    await signIn(tester);
    await tester.tap(find.byKey(const Key('section-tasks')));
    await tester.pumpAndSettle();
    expect(find.text('مهامي'), findsOneWidget);
    expect(find.text('مسندة إليك · أولوية عالية'), findsOneWidget);
    expect(Directionality.of(tester.element(find.byKey(const Key('task-t1')))), TextDirection.rtl);
    expect(api.calls.last, endsWith(' ar'));
  });
}

String _moment(WidgetTester tester, String iso) =>
    formatMoment(tester.element(find.byType(Scaffold).last), iso);

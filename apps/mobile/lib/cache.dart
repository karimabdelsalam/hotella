import 'dart:convert';

import 'session.dart';

/// The last good answer of each screen, so the app still shows the person's work when the network drops. Entries are
/// kept with the session in the Keychain/Keystore and wiped on sign-out: the next person on the phone never sees them.
class ReadCache {
  ReadCache(this.store);
  final SessionStore store;

  static const _index = 'cache.index';

  Future<void> put(String key, Object? data, DateTime at) async {
    await store.write('cache.$key', jsonEncode({'at': at.toUtc().toIso8601String(), 'data': data}));
    final keys = await _keys();
    if (keys.add(key)) await store.write(_index, jsonEncode(keys.toList()));
  }

  Future<({Object? data, DateTime at})?> get(String key) async {
    final text = await store.read('cache.$key');
    if (text == null) return null;
    try {
      final json = jsonDecode(text) as Map<String, Object?>;
      return (data: json['data'], at: DateTime.parse(json['at']! as String).toLocal());
    } on Object {
      return null;
    }
  }

  Future<void> clear() async {
    for (final key in await _keys()) {
      await store.write('cache.$key', null);
    }
    await store.write(_index, null);
  }

  Future<Set<String>> _keys() async {
    final text = await store.read(_index);
    if (text == null) return <String>{};
    try {
      return (jsonDecode(text) as List<Object?>).cast<String>().toSet();
    } on Object {
      return <String>{};
    }
  }
}

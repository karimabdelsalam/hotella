import 'dart:convert';

import 'package:http/http.dart' as http;

/// An API answer that was not a success: the HTTP status, the stable error code and the message the platform
/// localized for the person's language (RFC 9457 `detail`).
class ApiException implements Exception {
  const ApiException(this.status, this.code, this.detail);
  final int status;
  final String? code;
  final String? detail;

  /// No answer at all (no connection, DNS, timeout).
  bool get offline => status == 0;

  @override
  String toString() => 'ApiException($status, $code)';
}

/// Where the access token comes from and how it is renewed once it expires.
abstract class TokenSource {
  String? get accessToken;

  /// Renews the access token with the refresh token; false when the session is over.
  Future<bool> renew();
}

/// HTTP to the platform API (`<base>/api/v1`): JSON in and out, the person's language on every call, the bearer
/// token, one renewal and retry after a 401, and errors as [ApiException]. No business rules live here.
class ApiTransport {
  ApiTransport({required this.baseUrl, required this.client, this.tokens, this.locale = 'en'});

  /// The platform's origin, e.g. `https://api.hotella.example`.
  final String baseUrl;
  final http.Client client;
  TokenSource? tokens;
  String locale;

  static const _timeout = Duration(seconds: 20);

  Future<Object?> send(String method, String path, {Map<String, Object?>? body, Map<String, String?>? query}) async {
    final response = await _once(method, path, body, query);
    if (response.statusCode == 401 && tokens?.accessToken != null && !path.startsWith('/auth/')) {
      if (await tokens!.renew()) return _decode(await _once(method, path, body, query));
    }
    return _decode(response);
  }

  Future<http.Response> _once(
    String method,
    String path,
    Map<String, Object?>? body,
    Map<String, String?>? query,
  ) async {
    final params = {
      for (final e in (query ?? const <String, String?>{}).entries)
        if (e.value != null) e.key: e.value!,
    };
    final uri = Uri.parse('$baseUrl/api/v1$path').replace(queryParameters: params.isEmpty ? null : params);
    final request = http.Request(method, uri)
      ..headers['accept'] = 'application/json'
      ..headers['accept-language'] = locale;
    final token = tokens?.accessToken;
    if (token != null) request.headers['authorization'] = 'Bearer $token';
    if (body != null) {
      request.headers['content-type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    try {
      return await http.Response.fromStream(await client.send(request).timeout(_timeout));
    } on Exception {
      throw const ApiException(0, 'app.offline', null);
    }
  }

  Object? _decode(http.Response response) {
    final text = utf8.decode(response.bodyBytes);
    Object? json;
    if (text.isNotEmpty) {
      try {
        json = jsonDecode(text);
      } on FormatException {
        json = null;
      }
    }
    if (response.statusCode >= 200 && response.statusCode < 300) return json;
    final problem = json is Map<String, Object?> ? json : const <String, Object?>{};
    throw ApiException(response.statusCode, problem['code'] as String?, problem['detail'] as String?);
  }
}

import 'package:flutter/material.dart';

import '../app.dart';
import '../api/transport.dart';
import '../l10n/app_localizations.dart';
import '../session.dart';

/// The Planova attribution under every screen (rule 15): brand settings cannot remove it.
class PoweredBy extends StatelessWidget {
  const PoweredBy({super.key, required this.hotel});
  final Hotel? hotel;

  @override
  Widget build(BuildContext context) {
    final label = hotel?.attributionLabel ?? 'Powered by Planova';
    return Padding(
      padding: const EdgeInsetsDirectional.only(top: 12, bottom: 16),
      child: Text(
        label,
        key: const Key('powered-by'),
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.black54),
      ),
    );
  }
}

/// The hotel's logo (when it has one) or its initials.
class HotelMark extends StatelessWidget {
  const HotelMark({super.key, required this.hotel, required this.baseUrl, this.size = 56});
  final Hotel hotel;
  final String baseUrl;
  final double size;

  @override
  Widget build(BuildContext context) {
    final initials = hotel.displayName
        .split(RegExp(r'\s+'))
        .where((w) => w.isNotEmpty)
        .take(2)
        .map((w) => w.characters.first)
        .join();
    final fallback = CircleAvatar(
      radius: size / 2,
      backgroundColor: Color(hotel.colorValue),
      child: Text(
        initials,
        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
      ),
    );
    if (!hotel.hasLogo) return fallback;
    return Image.network(
      '$baseUrl/api/v1/public/branding/logo?property=${hotel.propertyId}&channel=APP',
      height: size,
      errorBuilder: (_, _, _) => fallback,
    );
  }
}

/// The language menu (each language by its own name).
class LanguageMenu extends StatelessWidget {
  const LanguageMenu({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      key: const Key('language'),
      icon: const Icon(Icons.language),
      tooltip: AppLocalizations.of(context).commonLanguage,
      onSelected: state.setLocale,
      itemBuilder: (_) => [
        for (final l in supportedLocales)
          CheckedPopupMenuItem(value: l, checked: l == state.locale, child: Text(localeNames[l]!)),
      ],
    );
  }
}

/// What to tell the person when a call fails: the platform's localized message, or a plain line of our own.
String errorText(BuildContext context, Object error) {
  final t = AppLocalizations.of(context);
  if (error is ApiException) {
    if (error.offline) return t.commonOffline;
    if (error.detail != null && error.detail!.isNotEmpty) return error.detail!;
  }
  return t.commonError;
}

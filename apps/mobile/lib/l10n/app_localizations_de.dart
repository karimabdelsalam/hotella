// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for German (`de`).
class AppLocalizationsDe extends AppLocalizations {
  AppLocalizationsDe([String locale = 'de']) : super(locale);

  @override
  String get appTitle => 'Hotella';

  @override
  String get commonError => 'Etwas ist schiefgelaufen. Bitte erneut versuchen.';

  @override
  String get commonLanguage => 'Sprache';

  @override
  String get commonOffline =>
      'Keine Verbindung. Versuchen Sie es erneut, wenn Sie wieder online sind.';

  @override
  String get homeNoSections =>
      'In diesem Hotel ist Ihnen noch nichts zugewiesen.';

  @override
  String get homeProperty => 'Hotel';

  @override
  String get homeSectionAlerts => 'Hinweise';

  @override
  String get homeSectionRequests => 'Gästeanfragen';

  @override
  String get homeSectionRestaurant => 'Restaurantreservierungen';

  @override
  String get homeSectionTasks => 'Meine Aufgaben';

  @override
  String homeSections(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count Bereiche für Sie',
      one: '$count Bereich für Sie',
    );
    return '$_temp0';
  }

  @override
  String get homeSignOut => 'Abmelden';

  @override
  String homeWelcome(String name) {
    return 'Hallo, $name';
  }

  @override
  String get homeWelcomePlain => 'Hallo';

  @override
  String get hotelChange => 'Hotel wechseln';

  @override
  String get hotelCode => 'Hotelcode';

  @override
  String get hotelContinue => 'Weiter';

  @override
  String get hotelIntro =>
      'Geben Sie den Hotelcode ein, den Sie von Ihrer Leitung erhalten haben.';

  @override
  String get hotelNotFound =>
      'Kein Hotel verwendet diesen Code. Bitte prüfen Sie ihn mit Ihrer Leitung.';

  @override
  String get hotelTitle => 'Ihr Hotel';

  @override
  String get signinEmail => 'Dienstliche E-Mail';

  @override
  String get signinFailed => 'E-Mail oder Passwort ist nicht richtig.';

  @override
  String get signinMfaHint =>
      'Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.';

  @override
  String get signinMfaTitle => 'Bestätigungscode';

  @override
  String get signinPassword => 'Passwort';

  @override
  String get signinSubmit => 'Anmelden';

  @override
  String signinTitle(String hotel) {
    return 'Bei $hotel anmelden';
  }

  @override
  String get signinVerify => 'Bestätigen';
}

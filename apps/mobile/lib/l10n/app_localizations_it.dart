// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Italian (`it`).
class AppLocalizationsIt extends AppLocalizations {
  AppLocalizationsIt([String locale = 'it']) : super(locale);

  @override
  String get appTitle => 'Hotella';

  @override
  String get commonError => 'Qualcosa è andato storto. Riprova.';

  @override
  String get commonLanguage => 'Lingua';

  @override
  String get commonOffline => 'Nessuna connessione. Riprova quando sei di nuovo online.';

  @override
  String get homeNoSections => 'Non ti è ancora assegnato nulla in questo hotel.';

  @override
  String get homeProperty => 'Hotel';

  @override
  String get homeSectionAlerts => 'Avvisi';

  @override
  String get homeSectionRequests => 'Richieste degli ospiti';

  @override
  String get homeSectionRestaurant => 'Prenotazioni ristorante';

  @override
  String get homeSectionTasks => 'I miei compiti';

  @override
  String homeSections(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count cose che puoi fare qui',
      many: '$count cose che puoi fare qui',
      one: '$count cosa che puoi fare qui',
    );
    return '$_temp0';
  }

  @override
  String get homeSignOut => 'Esci';

  @override
  String homeWelcome(String name) {
    return 'Ciao, $name';
  }

  @override
  String get homeWelcomePlain => 'Ciao';

  @override
  String get hotelChange => 'Cambia hotel';

  @override
  String get hotelCode => 'Codice hotel';

  @override
  String get hotelContinue => 'Continua';

  @override
  String get hotelIntro => 'Inserisci il codice hotel ricevuto dal tuo responsabile.';

  @override
  String get hotelNotFound => 'Nessun hotel usa questo codice. Verificalo con il tuo responsabile.';

  @override
  String get hotelTitle => 'Il tuo hotel';

  @override
  String get signinEmail => 'E-mail di lavoro';

  @override
  String get signinFailed => 'E-mail o password non corrette.';

  @override
  String get signinMfaHint => 'Inserisci il codice di 6 cifre dell’app di autenticazione.';

  @override
  String get signinMfaTitle => 'Codice di verifica';

  @override
  String get signinPassword => 'Password';

  @override
  String get signinSubmit => 'Accedi';

  @override
  String signinTitle(String hotel) {
    return 'Accedi a $hotel';
  }

  @override
  String get signinVerify => 'Verifica';
}

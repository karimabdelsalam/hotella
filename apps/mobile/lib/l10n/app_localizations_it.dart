// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Italian (`it`).
class AppLocalizationsIt extends AppLocalizations {
  AppLocalizationsIt([String locale = 'it']) : super(locale);

  @override
  String get alertAcknowledge => 'Presa visione';

  @override
  String alertLastSeen(String time) {
    return 'Ultima volta $time';
  }

  @override
  String get alertResolution => 'Cosa è stato fatto?';

  @override
  String get alertResolve => 'Risolvi';

  @override
  String alertSeen(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Visto $count volte',
      many: 'Visto $count volte',
      one: 'Visto una volta',
    );
    return '$_temp0';
  }

  @override
  String alertSeverity(String severity) {
    String _temp0 = intl.Intl.selectLogic(severity, {
      'CRITICAL': 'Critico',
      'WARNING': 'Attenzione',
      'other': 'Informazione',
    });
    return '$_temp0';
  }

  @override
  String alertStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Aperto',
      'ACKNOWLEDGED': 'Preso visione',
      'other': 'Risolto',
    });
    return '$_temp0';
  }

  @override
  String alertType(String type) {
    String _temp0 = intl.Intl.selectLogic(type, {
      'SLA_RESPONSE_BREACHED': 'Lavoro non preso in carico',
      'SLA_AT_RISK': 'Lavoro vicino alla scadenza',
      'SLA_RESOLUTION_BREACHED': 'Lavoro oltre la scadenza',
      'CHANNEL_UNHEALTHY': 'Un canale di messaggi agli ospiti non funziona',
      'AI_BUDGET_EXHAUSTED': 'Il budget IA è esaurito',
      'other': 'Richiede attenzione',
    });
    return '$_temp0';
  }

  @override
  String get alertsEmpty => 'Nessun avviso aperto.';

  @override
  String get alertsTitle => 'Avvisi';

  @override
  String get appTitle => 'Hotella';

  @override
  String get commonCancel => 'Annulla';

  @override
  String get commonError => 'Qualcosa è andato storto. Riprova.';

  @override
  String get commonLanguage => 'Lingua';

  @override
  String get commonOffline => 'Nessuna connessione. Riprova quando sei di nuovo online.';

  @override
  String get commonRetry => 'Riprova';

  @override
  String get commonSave => 'Salva';

  @override
  String commonSavedAt(String time) {
    return 'Offline: mostro i dati salvati alle $time.';
  }

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
  String get inboxEmpty => 'Ancora nessuna notifica.';

  @override
  String get inboxTitle => 'Notifiche';

  @override
  String requestAskedAgain(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Richiesta di nuovo $count volte',
      many: 'Richiesta di nuovo $count volte',
      one: 'Richiesta di nuovo $count volta',
    );
    return '$_temp0';
  }

  @override
  String requestAskedAt(String time) {
    return 'Richiesta alle $time';
  }

  @override
  String requestRoom(String room) {
    return 'Camera $room';
  }

  @override
  String requestStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Aperta',
      'IN_PROGRESS': 'In corso',
      'COMPLETED': 'Completata',
      'other': 'Annullata',
    });
    return '$_temp0';
  }

  @override
  String get requestTitle => 'Richiesta dell’ospite';

  @override
  String requestWantedFor(String time) {
    return 'Desiderata per $time';
  }

  @override
  String get requestsEmpty => 'Nessuna richiesta aperta.';

  @override
  String get requestsTitle => 'Richieste degli ospiti';

  @override
  String get reservationComplete => 'Conclusa';

  @override
  String get reservationNoShow => 'Non presentato';

  @override
  String get reservationNotes => 'Note dell’ospite';

  @override
  String reservationParty(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count ospiti',
      many: '$count ospiti',
      one: '$count ospite',
    );
    return '$_temp0';
  }

  @override
  String reservationRoom(String room) {
    return 'Camera $room';
  }

  @override
  String get reservationSeat => 'Fai accomodare';

  @override
  String reservationStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'CONFIRMED': 'Confermata',
      'SEATED': 'Al tavolo',
      'COMPLETED': 'Conclusa',
      'NO_SHOW': 'Non presentato',
      'other': 'Annullata',
    });
    return '$_temp0';
  }

  @override
  String get reservationTitle => 'Prenotazione';

  @override
  String reservationWhen(String date, String time) {
    return '$date alle $time';
  }

  @override
  String get restaurantEmpty => 'Nessuna prenotazione in questo giorno.';

  @override
  String get restaurantNextDay => 'Giorno successivo';

  @override
  String get restaurantPreviousDay => 'Giorno precedente';

  @override
  String restaurantSeats(String booked, String seats) {
    return '$booked di $seats posti prenotati';
  }

  @override
  String get restaurantTitle => 'Prenotazioni ristorante';

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

  @override
  String get taskComplete => 'Segna come fatto';

  @override
  String taskDue(String time) {
    return 'Scadenza $time';
  }

  @override
  String taskPartOf(String title) {
    return 'Parte di: $title';
  }

  @override
  String get taskPause => 'Metti in pausa';

  @override
  String get taskPauseReason => 'Perché lo metti in pausa?';

  @override
  String taskPriority(String priority) {
    String _temp0 = intl.Intl.selectLogic(priority, {
      'LOW': 'Priorità bassa',
      'HIGH': 'Priorità alta',
      'URGENT': 'Urgente',
      'other': 'Priorità normale',
    });
    return '$_temp0';
  }

  @override
  String get taskReject => 'Rifiuta';

  @override
  String get taskRejectReason => 'Perché lo rifiuti?';

  @override
  String get taskResume => 'Riprendi';

  @override
  String get taskStart => 'Inizia';

  @override
  String taskStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'NEW': 'Nuovo',
      'ASSIGNED': 'Assegnato a te',
      'ACCEPTED': 'Accettato',
      'IN_PROGRESS': 'In corso',
      'PAUSED': 'In pausa',
      'DONE': 'Fatto',
      'other': 'Annullato',
    });
    return '$_temp0';
  }

  @override
  String get taskTitle => 'Compito';

  @override
  String get tasksEmpty => 'Nessun compito aperto per te.';

  @override
  String get tasksTitle => 'I miei compiti';

  @override
  String workStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Aperto',
      'IN_PROGRESS': 'In corso',
      'RESOLVED': 'Risolto',
      'other': 'Annullato',
    });
    return '$_temp0';
  }

  @override
  String get workTasks => 'Compiti';

  @override
  String get workTitle => 'Lavoro';
}

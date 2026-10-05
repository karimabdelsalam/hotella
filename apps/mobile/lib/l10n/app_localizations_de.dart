// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for German (`de`).
class AppLocalizationsDe extends AppLocalizations {
  AppLocalizationsDe([String locale = 'de']) : super(locale);

  @override
  String get alertAcknowledge => 'Zur Kenntnis nehmen';

  @override
  String alertLastSeen(String time) {
    return 'Zuletzt $time';
  }

  @override
  String get alertResolution => 'Was wurde getan?';

  @override
  String get alertResolve => 'Erledigen';

  @override
  String alertSeen(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count Mal aufgetreten',
      one: 'Einmal aufgetreten',
    );
    return '$_temp0';
  }

  @override
  String alertSeverity(String severity) {
    String _temp0 = intl.Intl.selectLogic(severity, {
      'CRITICAL': 'Kritisch',
      'WARNING': 'Warnung',
      'other': 'Information',
    });
    return '$_temp0';
  }

  @override
  String alertStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Offen',
      'ACKNOWLEDGED': 'Zur Kenntnis genommen',
      'other': 'Erledigt',
    });
    return '$_temp0';
  }

  @override
  String alertType(String type) {
    String _temp0 = intl.Intl.selectLogic(type, {
      'SLA_RESPONSE_BREACHED': 'Vorgang nicht übernommen',
      'SLA_AT_RISK': 'Vorgang kurz vor der Frist',
      'SLA_RESOLUTION_BREACHED': 'Vorgang über der Frist',
      'CHANNEL_UNHEALTHY': 'Ein Nachrichtenkanal zu Gästen fällt aus',
      'AI_BUDGET_EXHAUSTED': 'Das KI-Budget ist aufgebraucht',
      'other': 'Erfordert Aufmerksamkeit',
    });
    return '$_temp0';
  }

  @override
  String get alertsEmpty => 'Keine offenen Warnungen.';

  @override
  String get alertsTitle => 'Warnungen';

  @override
  String get appTitle => 'Hotella';

  @override
  String get commonCancel => 'Abbrechen';

  @override
  String get commonError => 'Etwas ist schiefgelaufen. Bitte erneut versuchen.';

  @override
  String get commonLanguage => 'Sprache';

  @override
  String get commonOffline => 'Keine Verbindung. Versuchen Sie es erneut, wenn Sie wieder online sind.';

  @override
  String get commonRetry => 'Erneut versuchen';

  @override
  String get commonSave => 'Speichern';

  @override
  String commonSavedAt(String time) {
    return 'Offline: Angezeigt wird der Stand von $time.';
  }

  @override
  String get homeNoSections => 'In diesem Hotel ist Ihnen noch nichts zugewiesen.';

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
  String get hotelIntro => 'Geben Sie den Hotelcode ein, den Sie von Ihrer Leitung erhalten haben.';

  @override
  String get hotelNotFound => 'Kein Hotel verwendet diesen Code. Bitte prüfen Sie ihn mit Ihrer Leitung.';

  @override
  String get hotelTitle => 'Ihr Hotel';

  @override
  String get inboxEmpty => 'Noch keine Benachrichtigungen.';

  @override
  String get inboxTitle => 'Benachrichtigungen';

  @override
  String requestAskedAgain(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count Mal erneut gewünscht',
      one: '$count Mal erneut gewünscht',
    );
    return '$_temp0';
  }

  @override
  String requestAskedAt(String time) {
    return 'Gewünscht um $time';
  }

  @override
  String requestRoom(String room) {
    return 'Zimmer $room';
  }

  @override
  String requestStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Offen',
      'IN_PROGRESS': 'In Arbeit',
      'COMPLETED': 'Erledigt',
      'other': 'Storniert',
    });
    return '$_temp0';
  }

  @override
  String get requestTitle => 'Gästewunsch';

  @override
  String requestWantedFor(String time) {
    return 'Gewünscht für $time';
  }

  @override
  String get requestsEmpty => 'Keine offenen Gästewünsche.';

  @override
  String get requestsTitle => 'Gästewünsche';

  @override
  String get reservationComplete => 'Beendet';

  @override
  String get reservationNoShow => 'Nicht erschienen';

  @override
  String get reservationNotes => 'Hinweise des Gastes';

  @override
  String reservationParty(num count) {
    String _temp0 = intl.Intl.pluralLogic(count, locale: localeName, other: '$count Gäste', one: '$count Gast');
    return '$_temp0';
  }

  @override
  String reservationRoom(String room) {
    return 'Zimmer $room';
  }

  @override
  String get reservationSeat => 'Platzieren';

  @override
  String reservationStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'CONFIRMED': 'Bestätigt',
      'SEATED': 'Platziert',
      'COMPLETED': 'Beendet',
      'NO_SHOW': 'Nicht erschienen',
      'other': 'Storniert',
    });
    return '$_temp0';
  }

  @override
  String get reservationTitle => 'Reservierung';

  @override
  String reservationWhen(String date, String time) {
    return '$date um $time';
  }

  @override
  String get restaurantEmpty => 'An diesem Tag gibt es keine Reservierungen.';

  @override
  String get restaurantNextDay => 'Nächster Tag';

  @override
  String get restaurantPreviousDay => 'Vorheriger Tag';

  @override
  String restaurantSeats(String booked, String seats) {
    return '$booked von $seats Plätzen reserviert';
  }

  @override
  String get restaurantTitle => 'Restaurantreservierungen';

  @override
  String get signinEmail => 'Dienstliche E-Mail';

  @override
  String get signinFailed => 'E-Mail oder Passwort ist nicht richtig.';

  @override
  String get signinMfaHint => 'Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.';

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

  @override
  String get taskComplete => 'Als erledigt markieren';

  @override
  String taskDue(String time) {
    return 'Fällig $time';
  }

  @override
  String taskPartOf(String title) {
    return 'Teil von: $title';
  }

  @override
  String get taskPause => 'Pausieren';

  @override
  String get taskPauseReason => 'Warum pausieren Sie?';

  @override
  String taskPriority(String priority) {
    String _temp0 = intl.Intl.selectLogic(priority, {
      'LOW': 'Niedrige Priorität',
      'HIGH': 'Hohe Priorität',
      'URGENT': 'Dringend',
      'other': 'Normale Priorität',
    });
    return '$_temp0';
  }

  @override
  String get taskReject => 'Ablehnen';

  @override
  String get taskRejectReason => 'Warum lehnen Sie ab?';

  @override
  String get taskResume => 'Fortsetzen';

  @override
  String get taskStart => 'Starten';

  @override
  String taskStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'NEW': 'Neu',
      'ASSIGNED': 'Ihnen zugewiesen',
      'ACCEPTED': 'Angenommen',
      'IN_PROGRESS': 'In Arbeit',
      'PAUSED': 'Pausiert',
      'DONE': 'Erledigt',
      'other': 'Storniert',
    });
    return '$_temp0';
  }

  @override
  String get taskTitle => 'Aufgabe';

  @override
  String get tasksEmpty => 'Sie haben keine offenen Aufgaben.';

  @override
  String get tasksTitle => 'Meine Aufgaben';

  @override
  String workStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Offen',
      'IN_PROGRESS': 'In Arbeit',
      'RESOLVED': 'Erledigt',
      'other': 'Storniert',
    });
    return '$_temp0';
  }

  @override
  String get workTasks => 'Aufgaben';

  @override
  String get workTitle => 'Vorgang';
}

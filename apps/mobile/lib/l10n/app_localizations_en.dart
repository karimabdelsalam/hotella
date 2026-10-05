// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get alertAcknowledge => 'Acknowledge';

  @override
  String alertLastSeen(String time) {
    return 'Last seen $time';
  }

  @override
  String get alertResolution => 'What was done?';

  @override
  String get alertResolve => 'Resolve';

  @override
  String alertSeen(num count) {
    String _temp0 = intl.Intl.pluralLogic(count, locale: localeName, other: 'Seen $count times', one: 'Seen once');
    return '$_temp0';
  }

  @override
  String alertSeverity(String severity) {
    String _temp0 = intl.Intl.selectLogic(severity, {
      'CRITICAL': 'Critical',
      'WARNING': 'Warning',
      'other': 'Information',
    });
    return '$_temp0';
  }

  @override
  String alertStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Open',
      'ACKNOWLEDGED': 'Acknowledged',
      'other': 'Resolved',
    });
    return '$_temp0';
  }

  @override
  String alertType(String type) {
    String _temp0 = intl.Intl.selectLogic(type, {
      'SLA_RESPONSE_BREACHED': 'Work not picked up',
      'SLA_AT_RISK': 'Work close to its deadline',
      'SLA_RESOLUTION_BREACHED': 'Work past its deadline',
      'CHANNEL_UNHEALTHY': 'A guest messaging channel is failing',
      'AI_BUDGET_EXHAUSTED': 'The AI budget is used up',
      'TELEMETRY_ALARM': 'A building sensor alarm',
      'other': 'Needs attention',
    });
    return '$_temp0';
  }

  @override
  String get alertsEmpty => 'No open alerts.';

  @override
  String get alertsTitle => 'Alerts';

  @override
  String get appTitle => 'Hotella';

  @override
  String get commonCancel => 'Cancel';

  @override
  String get commonError => 'Something went wrong. Please try again.';

  @override
  String get commonLanguage => 'Language';

  @override
  String get commonOffline => 'No connection. Try again when you are back online.';

  @override
  String get commonRetry => 'Try again';

  @override
  String get commonSave => 'Save';

  @override
  String commonSavedAt(String time) {
    return 'Offline: showing what was saved at $time.';
  }

  @override
  String get homeNoSections => 'Nothing is assigned to you in this hotel yet.';

  @override
  String get homeProperty => 'Hotel';

  @override
  String get homeSectionAlerts => 'Alerts';

  @override
  String get homeSectionRequests => 'Guest requests';

  @override
  String get homeSectionRestaurant => 'Restaurant bookings';

  @override
  String get homeSectionTasks => 'My tasks';

  @override
  String homeSections(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count things you can do here',
      one: '$count thing you can do here',
    );
    return '$_temp0';
  }

  @override
  String get homeSignOut => 'Sign out';

  @override
  String homeWelcome(String name) {
    return 'Hello, $name';
  }

  @override
  String get homeWelcomePlain => 'Hello';

  @override
  String get hotelChange => 'Change hotel';

  @override
  String get hotelCode => 'Hotel code';

  @override
  String get hotelContinue => 'Continue';

  @override
  String get hotelIntro => 'Enter the hotel code your manager gave you.';

  @override
  String get hotelNotFound => 'No hotel uses this code. Check it with your manager.';

  @override
  String get hotelTitle => 'Your hotel';

  @override
  String get inboxEmpty => 'No notifications yet.';

  @override
  String get inboxTitle => 'Notifications';

  @override
  String requestAskedAgain(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Asked again $count times',
      one: 'Asked again $count time',
    );
    return '$_temp0';
  }

  @override
  String requestAskedAt(String time) {
    return 'Asked at $time';
  }

  @override
  String requestRoom(String room) {
    return 'Room $room';
  }

  @override
  String requestStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Open',
      'IN_PROGRESS': 'In progress',
      'COMPLETED': 'Completed',
      'other': 'Cancelled',
    });
    return '$_temp0';
  }

  @override
  String get requestTitle => 'Guest request';

  @override
  String requestWantedFor(String time) {
    return 'Wanted for $time';
  }

  @override
  String get requestsEmpty => 'No open guest requests.';

  @override
  String get requestsTitle => 'Guest requests';

  @override
  String get reservationComplete => 'Finished';

  @override
  String get reservationNoShow => 'No-show';

  @override
  String get reservationNotes => 'Notes from the guest';

  @override
  String reservationParty(num count) {
    String _temp0 = intl.Intl.pluralLogic(count, locale: localeName, other: '$count guests', one: '$count guest');
    return '$_temp0';
  }

  @override
  String reservationRoom(String room) {
    return 'Room $room';
  }

  @override
  String get reservationSeat => 'Seat';

  @override
  String reservationStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'CONFIRMED': 'Confirmed',
      'SEATED': 'Seated',
      'COMPLETED': 'Finished',
      'NO_SHOW': 'No-show',
      'other': 'Cancelled',
    });
    return '$_temp0';
  }

  @override
  String get reservationTitle => 'Booking';

  @override
  String reservationWhen(String date, String time) {
    return '$date at $time';
  }

  @override
  String get restaurantEmpty => 'No bookings on this day.';

  @override
  String get restaurantNextDay => 'Next day';

  @override
  String get restaurantPreviousDay => 'Previous day';

  @override
  String restaurantSeats(String booked, String seats) {
    return '$booked of $seats seats booked';
  }

  @override
  String get restaurantTitle => 'Restaurant bookings';

  @override
  String get signinEmail => 'Work e-mail';

  @override
  String get signinFailed => 'The e-mail or password is not right.';

  @override
  String get signinMfaHint => 'Enter the 6-digit code from your authenticator app.';

  @override
  String get signinMfaTitle => 'Verification code';

  @override
  String get signinPassword => 'Password';

  @override
  String get signinSubmit => 'Sign in';

  @override
  String signinTitle(String hotel) {
    return 'Sign in to $hotel';
  }

  @override
  String get signinVerify => 'Verify';

  @override
  String get taskComplete => 'Mark as done';

  @override
  String taskDue(String time) {
    return 'Due $time';
  }

  @override
  String taskPartOf(String title) {
    return 'Part of: $title';
  }

  @override
  String get taskPause => 'Pause';

  @override
  String get taskPauseReason => 'Why are you pausing?';

  @override
  String taskPriority(String priority) {
    String _temp0 = intl.Intl.selectLogic(priority, {
      'LOW': 'Low priority',
      'HIGH': 'High priority',
      'URGENT': 'Urgent',
      'other': 'Normal priority',
    });
    return '$_temp0';
  }

  @override
  String get taskReject => 'Decline';

  @override
  String get taskRejectReason => 'Why are you declining?';

  @override
  String get taskResume => 'Resume';

  @override
  String get taskStart => 'Start';

  @override
  String taskStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'NEW': 'New',
      'ASSIGNED': 'Assigned to you',
      'ACCEPTED': 'Accepted',
      'IN_PROGRESS': 'In progress',
      'PAUSED': 'Paused',
      'DONE': 'Done',
      'other': 'Cancelled',
    });
    return '$_temp0';
  }

  @override
  String get taskTitle => 'Task';

  @override
  String get tasksEmpty => 'No open tasks for you.';

  @override
  String get tasksTitle => 'My tasks';

  @override
  String workStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Open',
      'IN_PROGRESS': 'In progress',
      'RESOLVED': 'Resolved',
      'other': 'Cancelled',
    });
    return '$_temp0';
  }

  @override
  String get workTasks => 'Tasks';

  @override
  String get workTitle => 'Work';
}

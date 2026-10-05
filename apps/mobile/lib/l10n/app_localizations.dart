import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_ar.dart';
import 'app_localizations_de.dart';
import 'app_localizations_en.dart';
import 'app_localizations_it.dart';
import 'app_localizations_ru.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale) : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations)!;
  }

  static const LocalizationsDelegate<AppLocalizations> delegate = _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates = <LocalizationsDelegate<dynamic>>[
    delegate,
    GlobalMaterialLocalizations.delegate,
    GlobalCupertinoLocalizations.delegate,
    GlobalWidgetsLocalizations.delegate,
  ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('ar'),
    Locale('de'),
    Locale('en'),
    Locale('it'),
    Locale('ru'),
  ];

  /// mobile.alert.acknowledge
  ///
  /// In en, this message translates to:
  /// **'Acknowledge'**
  String get alertAcknowledge;

  /// mobile.alert.last_seen
  ///
  /// In en, this message translates to:
  /// **'Last seen {time}'**
  String alertLastSeen(String time);

  /// mobile.alert.resolution
  ///
  /// In en, this message translates to:
  /// **'What was done?'**
  String get alertResolution;

  /// mobile.alert.resolve
  ///
  /// In en, this message translates to:
  /// **'Resolve'**
  String get alertResolve;

  /// mobile.alert.seen
  ///
  /// In en, this message translates to:
  /// **'{count, plural, one {Seen once} other {Seen {count} times}}'**
  String alertSeen(num count);

  /// mobile.alert.severity
  ///
  /// In en, this message translates to:
  /// **'{severity, select, CRITICAL {Critical} WARNING {Warning} other {Information}}'**
  String alertSeverity(String severity);

  /// mobile.alert.status
  ///
  /// In en, this message translates to:
  /// **'{status, select, OPEN {Open} ACKNOWLEDGED {Acknowledged} other {Resolved}}'**
  String alertStatus(String status);

  /// mobile.alert.type
  ///
  /// In en, this message translates to:
  /// **'{type, select, SLA_RESPONSE_BREACHED {Work not picked up} SLA_AT_RISK {Work close to its deadline} SLA_RESOLUTION_BREACHED {Work past its deadline} CHANNEL_UNHEALTHY {A guest messaging channel is failing} AI_BUDGET_EXHAUSTED {The AI budget is used up} other {Needs attention}}'**
  String alertType(String type);

  /// mobile.alerts.empty
  ///
  /// In en, this message translates to:
  /// **'No open alerts.'**
  String get alertsEmpty;

  /// mobile.alerts.title
  ///
  /// In en, this message translates to:
  /// **'Alerts'**
  String get alertsTitle;

  /// mobile.app.title
  ///
  /// In en, this message translates to:
  /// **'Hotella'**
  String get appTitle;

  /// mobile.common.cancel
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get commonCancel;

  /// mobile.common.error
  ///
  /// In en, this message translates to:
  /// **'Something went wrong. Please try again.'**
  String get commonError;

  /// mobile.common.language
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get commonLanguage;

  /// mobile.common.offline
  ///
  /// In en, this message translates to:
  /// **'No connection. Try again when you are back online.'**
  String get commonOffline;

  /// mobile.common.retry
  ///
  /// In en, this message translates to:
  /// **'Try again'**
  String get commonRetry;

  /// mobile.common.save
  ///
  /// In en, this message translates to:
  /// **'Save'**
  String get commonSave;

  /// mobile.common.saved_at
  ///
  /// In en, this message translates to:
  /// **'Offline: showing what was saved at {time}.'**
  String commonSavedAt(String time);

  /// mobile.home.no_sections
  ///
  /// In en, this message translates to:
  /// **'Nothing is assigned to you in this hotel yet.'**
  String get homeNoSections;

  /// mobile.home.property
  ///
  /// In en, this message translates to:
  /// **'Hotel'**
  String get homeProperty;

  /// mobile.home.section.alerts
  ///
  /// In en, this message translates to:
  /// **'Alerts'**
  String get homeSectionAlerts;

  /// mobile.home.section.requests
  ///
  /// In en, this message translates to:
  /// **'Guest requests'**
  String get homeSectionRequests;

  /// mobile.home.section.restaurant
  ///
  /// In en, this message translates to:
  /// **'Restaurant bookings'**
  String get homeSectionRestaurant;

  /// mobile.home.section.tasks
  ///
  /// In en, this message translates to:
  /// **'My tasks'**
  String get homeSectionTasks;

  /// mobile.home.sections
  ///
  /// In en, this message translates to:
  /// **'{count, plural, one {{count} thing you can do here} other {{count} things you can do here}}'**
  String homeSections(num count);

  /// mobile.home.sign_out
  ///
  /// In en, this message translates to:
  /// **'Sign out'**
  String get homeSignOut;

  /// mobile.home.welcome
  ///
  /// In en, this message translates to:
  /// **'Hello, {name}'**
  String homeWelcome(String name);

  /// mobile.home.welcome_plain
  ///
  /// In en, this message translates to:
  /// **'Hello'**
  String get homeWelcomePlain;

  /// mobile.hotel.change
  ///
  /// In en, this message translates to:
  /// **'Change hotel'**
  String get hotelChange;

  /// mobile.hotel.code
  ///
  /// In en, this message translates to:
  /// **'Hotel code'**
  String get hotelCode;

  /// mobile.hotel.continue
  ///
  /// In en, this message translates to:
  /// **'Continue'**
  String get hotelContinue;

  /// mobile.hotel.intro
  ///
  /// In en, this message translates to:
  /// **'Enter the hotel code your manager gave you.'**
  String get hotelIntro;

  /// mobile.hotel.not_found
  ///
  /// In en, this message translates to:
  /// **'No hotel uses this code. Check it with your manager.'**
  String get hotelNotFound;

  /// mobile.hotel.title
  ///
  /// In en, this message translates to:
  /// **'Your hotel'**
  String get hotelTitle;

  /// mobile.inbox.empty
  ///
  /// In en, this message translates to:
  /// **'No notifications yet.'**
  String get inboxEmpty;

  /// mobile.inbox.title
  ///
  /// In en, this message translates to:
  /// **'Notifications'**
  String get inboxTitle;

  /// mobile.request.asked_again
  ///
  /// In en, this message translates to:
  /// **'{count, plural, one {Asked again {count} time} other {Asked again {count} times}}'**
  String requestAskedAgain(num count);

  /// mobile.request.asked_at
  ///
  /// In en, this message translates to:
  /// **'Asked at {time}'**
  String requestAskedAt(String time);

  /// mobile.request.room
  ///
  /// In en, this message translates to:
  /// **'Room {room}'**
  String requestRoom(String room);

  /// mobile.request.status
  ///
  /// In en, this message translates to:
  /// **'{status, select, OPEN {Open} IN_PROGRESS {In progress} COMPLETED {Completed} other {Cancelled}}'**
  String requestStatus(String status);

  /// mobile.request.title
  ///
  /// In en, this message translates to:
  /// **'Guest request'**
  String get requestTitle;

  /// mobile.request.wanted_for
  ///
  /// In en, this message translates to:
  /// **'Wanted for {time}'**
  String requestWantedFor(String time);

  /// mobile.requests.empty
  ///
  /// In en, this message translates to:
  /// **'No open guest requests.'**
  String get requestsEmpty;

  /// mobile.requests.title
  ///
  /// In en, this message translates to:
  /// **'Guest requests'**
  String get requestsTitle;

  /// mobile.reservation.complete
  ///
  /// In en, this message translates to:
  /// **'Finished'**
  String get reservationComplete;

  /// mobile.reservation.no_show
  ///
  /// In en, this message translates to:
  /// **'No-show'**
  String get reservationNoShow;

  /// mobile.reservation.notes
  ///
  /// In en, this message translates to:
  /// **'Notes from the guest'**
  String get reservationNotes;

  /// mobile.reservation.party
  ///
  /// In en, this message translates to:
  /// **'{count, plural, one {{count} guest} other {{count} guests}}'**
  String reservationParty(num count);

  /// mobile.reservation.room
  ///
  /// In en, this message translates to:
  /// **'Room {room}'**
  String reservationRoom(String room);

  /// mobile.reservation.seat
  ///
  /// In en, this message translates to:
  /// **'Seat'**
  String get reservationSeat;

  /// mobile.reservation.status
  ///
  /// In en, this message translates to:
  /// **'{status, select, CONFIRMED {Confirmed} SEATED {Seated} COMPLETED {Finished} NO_SHOW {No-show} other {Cancelled}}'**
  String reservationStatus(String status);

  /// mobile.reservation.title
  ///
  /// In en, this message translates to:
  /// **'Booking'**
  String get reservationTitle;

  /// mobile.reservation.when
  ///
  /// In en, this message translates to:
  /// **'{date} at {time}'**
  String reservationWhen(String date, String time);

  /// mobile.restaurant.empty
  ///
  /// In en, this message translates to:
  /// **'No bookings on this day.'**
  String get restaurantEmpty;

  /// mobile.restaurant.next_day
  ///
  /// In en, this message translates to:
  /// **'Next day'**
  String get restaurantNextDay;

  /// mobile.restaurant.previous_day
  ///
  /// In en, this message translates to:
  /// **'Previous day'**
  String get restaurantPreviousDay;

  /// mobile.restaurant.seats
  ///
  /// In en, this message translates to:
  /// **'{booked} of {seats} seats booked'**
  String restaurantSeats(String booked, String seats);

  /// mobile.restaurant.title
  ///
  /// In en, this message translates to:
  /// **'Restaurant bookings'**
  String get restaurantTitle;

  /// mobile.signin.email
  ///
  /// In en, this message translates to:
  /// **'Work e-mail'**
  String get signinEmail;

  /// mobile.signin.failed
  ///
  /// In en, this message translates to:
  /// **'The e-mail or password is not right.'**
  String get signinFailed;

  /// mobile.signin.mfa_hint
  ///
  /// In en, this message translates to:
  /// **'Enter the 6-digit code from your authenticator app.'**
  String get signinMfaHint;

  /// mobile.signin.mfa_title
  ///
  /// In en, this message translates to:
  /// **'Verification code'**
  String get signinMfaTitle;

  /// mobile.signin.password
  ///
  /// In en, this message translates to:
  /// **'Password'**
  String get signinPassword;

  /// mobile.signin.submit
  ///
  /// In en, this message translates to:
  /// **'Sign in'**
  String get signinSubmit;

  /// mobile.signin.title
  ///
  /// In en, this message translates to:
  /// **'Sign in to {hotel}'**
  String signinTitle(String hotel);

  /// mobile.signin.verify
  ///
  /// In en, this message translates to:
  /// **'Verify'**
  String get signinVerify;

  /// mobile.task.complete
  ///
  /// In en, this message translates to:
  /// **'Mark as done'**
  String get taskComplete;

  /// mobile.task.due
  ///
  /// In en, this message translates to:
  /// **'Due {time}'**
  String taskDue(String time);

  /// mobile.task.part_of
  ///
  /// In en, this message translates to:
  /// **'Part of: {title}'**
  String taskPartOf(String title);

  /// mobile.task.pause
  ///
  /// In en, this message translates to:
  /// **'Pause'**
  String get taskPause;

  /// mobile.task.pause_reason
  ///
  /// In en, this message translates to:
  /// **'Why are you pausing?'**
  String get taskPauseReason;

  /// mobile.task.priority
  ///
  /// In en, this message translates to:
  /// **'{priority, select, LOW {Low priority} HIGH {High priority} URGENT {Urgent} other {Normal priority}}'**
  String taskPriority(String priority);

  /// mobile.task.reject
  ///
  /// In en, this message translates to:
  /// **'Decline'**
  String get taskReject;

  /// mobile.task.reject_reason
  ///
  /// In en, this message translates to:
  /// **'Why are you declining?'**
  String get taskRejectReason;

  /// mobile.task.resume
  ///
  /// In en, this message translates to:
  /// **'Resume'**
  String get taskResume;

  /// mobile.task.start
  ///
  /// In en, this message translates to:
  /// **'Start'**
  String get taskStart;

  /// mobile.task.status
  ///
  /// In en, this message translates to:
  /// **'{status, select, NEW {New} ASSIGNED {Assigned to you} ACCEPTED {Accepted} IN_PROGRESS {In progress} PAUSED {Paused} DONE {Done} other {Cancelled}}'**
  String taskStatus(String status);

  /// mobile.task.title
  ///
  /// In en, this message translates to:
  /// **'Task'**
  String get taskTitle;

  /// mobile.tasks.empty
  ///
  /// In en, this message translates to:
  /// **'No open tasks for you.'**
  String get tasksEmpty;

  /// mobile.tasks.title
  ///
  /// In en, this message translates to:
  /// **'My tasks'**
  String get tasksTitle;

  /// mobile.work.status
  ///
  /// In en, this message translates to:
  /// **'{status, select, OPEN {Open} IN_PROGRESS {In progress} RESOLVED {Resolved} other {Cancelled}}'**
  String workStatus(String status);

  /// mobile.work.tasks
  ///
  /// In en, this message translates to:
  /// **'Tasks'**
  String get workTasks;

  /// mobile.work.title
  ///
  /// In en, this message translates to:
  /// **'Work'**
  String get workTitle;
}

class _AppLocalizationsDelegate extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) => <String>['ar', 'de', 'en', 'it', 'ru'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'ar':
      return AppLocalizationsAr();
    case 'de':
      return AppLocalizationsDe();
    case 'en':
      return AppLocalizationsEn();
    case 'it':
      return AppLocalizationsIt();
    case 'ru':
      return AppLocalizationsRu();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}

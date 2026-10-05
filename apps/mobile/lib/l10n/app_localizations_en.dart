// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'Hotella';

  @override
  String get commonError => 'Something went wrong. Please try again.';

  @override
  String get commonLanguage => 'Language';

  @override
  String get commonOffline =>
      'No connection. Try again when you are back online.';

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
  String get hotelNotFound =>
      'No hotel uses this code. Check it with your manager.';

  @override
  String get hotelTitle => 'Your hotel';

  @override
  String get signinEmail => 'Work e-mail';

  @override
  String get signinFailed => 'The e-mail or password is not right.';

  @override
  String get signinMfaHint =>
      'Enter the 6-digit code from your authenticator app.';

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
}

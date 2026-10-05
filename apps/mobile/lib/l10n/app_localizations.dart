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

  /// mobile.app.title
  ///
  /// In en, this message translates to:
  /// **'Hotella'**
  String get appTitle;

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

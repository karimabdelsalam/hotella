// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Arabic (`ar`).
class AppLocalizationsAr extends AppLocalizations {
  AppLocalizationsAr([String locale = 'ar']) : super(locale);

  @override
  String get appTitle => 'Hotella';

  @override
  String get commonError => 'حدث خطأ. حاول مرة أخرى.';

  @override
  String get commonLanguage => 'اللغة';

  @override
  String get commonOffline => 'لا يوجد اتصال. حاول مرة أخرى عند عودة الإنترنت.';

  @override
  String get homeNoSections => 'لم يُسند إليك شيء في هذا الفندق بعد.';

  @override
  String get homeProperty => 'الفندق';

  @override
  String get homeSectionAlerts => 'التنبيهات';

  @override
  String get homeSectionRequests => 'طلبات الضيوف';

  @override
  String get homeSectionRestaurant => 'حجوزات المطاعم';

  @override
  String get homeSectionTasks => 'مهامي';

  @override
  String homeSections(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count قسم متاح لك هنا',
      many: '$count قسمًا متاحًا لك هنا',
      few: '$count أقسام متاحة لك هنا',
      two: 'قسمان متاحان لك هنا',
      one: 'قسم واحد متاح لك هنا',
      zero: 'لا شيء متاح لك هنا',
    );
    return '$_temp0';
  }

  @override
  String get homeSignOut => 'تسجيل الخروج';

  @override
  String homeWelcome(String name) {
    return 'أهلًا، $name';
  }

  @override
  String get homeWelcomePlain => 'أهلًا';

  @override
  String get hotelChange => 'تغيير الفندق';

  @override
  String get hotelCode => 'كود الفندق';

  @override
  String get hotelContinue => 'متابعة';

  @override
  String get hotelIntro => 'أدخل كود الفندق الذي أعطاك إياه مديرك.';

  @override
  String get hotelNotFound => 'لا يوجد فندق بهذا الكود. تأكد منه مع مديرك.';

  @override
  String get hotelTitle => 'فندقك';

  @override
  String get signinEmail => 'بريد العمل';

  @override
  String get signinFailed => 'البريد أو كلمة المرور غير صحيحة.';

  @override
  String get signinMfaHint =>
      'أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة.';

  @override
  String get signinMfaTitle => 'رمز التحقق';

  @override
  String get signinPassword => 'كلمة المرور';

  @override
  String get signinSubmit => 'تسجيل الدخول';

  @override
  String signinTitle(String hotel) {
    return 'تسجيل الدخول إلى $hotel';
  }

  @override
  String get signinVerify => 'تحقق';
}

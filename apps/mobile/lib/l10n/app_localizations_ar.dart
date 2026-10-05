// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Arabic (`ar`).
class AppLocalizationsAr extends AppLocalizations {
  AppLocalizationsAr([String locale = 'ar']) : super(locale);

  @override
  String get alertAcknowledge => 'تم الاطلاع';

  @override
  String alertLastSeen(String time) {
    return 'آخر رصد $time';
  }

  @override
  String get alertResolution => 'ما الذي تم عمله؟';

  @override
  String get alertResolve => 'حل';

  @override
  String alertSeen(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'رُصد $count مرة',
      many: 'رُصد $count مرة',
      few: 'رُصد $count مرات',
      two: 'رُصد مرتين',
      one: 'رُصد مرة واحدة',
      zero: 'لم يُرصد',
    );
    return '$_temp0';
  }

  @override
  String alertSeverity(String severity) {
    String _temp0 = intl.Intl.selectLogic(severity, {'CRITICAL': 'حرج', 'WARNING': 'تحذير', 'other': 'معلومة'});
    return '$_temp0';
  }

  @override
  String alertStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {'OPEN': 'مفتوح', 'ACKNOWLEDGED': 'تم الاطلاع', 'other': 'تم الحل'});
    return '$_temp0';
  }

  @override
  String alertType(String type) {
    String _temp0 = intl.Intl.selectLogic(type, {
      'SLA_RESPONSE_BREACHED': 'لم يستلم أحد العمل',
      'SLA_AT_RISK': 'العمل يقترب من موعده النهائي',
      'SLA_RESOLUTION_BREACHED': 'تجاوز العمل موعده النهائي',
      'CHANNEL_UNHEALTHY': 'قناة مراسلة الضيوف لا تعمل',
      'AI_BUDGET_EXHAUSTED': 'نفدت ميزانية الذكاء الاصطناعي',
      'TELEMETRY_ALARM': 'إنذار من حساسات المبنى',
      'other': 'يحتاج إلى متابعة',
    });
    return '$_temp0';
  }

  @override
  String get alertsEmpty => 'لا توجد تنبيهات مفتوحة.';

  @override
  String get alertsTitle => 'التنبيهات';

  @override
  String get appTitle => 'Hotella';

  @override
  String get commonCancel => 'إلغاء';

  @override
  String get commonError => 'حدث خطأ. حاول مرة أخرى.';

  @override
  String get commonLanguage => 'اللغة';

  @override
  String get commonOffline => 'لا يوجد اتصال. حاول مرة أخرى عند عودة الإنترنت.';

  @override
  String get commonRetry => 'حاول مرة أخرى';

  @override
  String get commonSave => 'حفظ';

  @override
  String commonSavedAt(String time) {
    return 'لا يوجد اتصال: يتم عرض ما تم حفظه الساعة $time.';
  }

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
  String get inboxEmpty => 'لا توجد إشعارات بعد.';

  @override
  String get inboxTitle => 'الإشعارات';

  @override
  String requestAskedAgain(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'طُلب مجددًا $count مرة',
      many: 'طُلب مجددًا $count مرة',
      few: 'طُلب مجددًا $count مرات',
      two: 'طُلب مجددًا مرتين',
      one: 'طُلب مجددًا مرة واحدة',
      zero: 'لم يُطلب مجددًا',
    );
    return '$_temp0';
  }

  @override
  String requestAskedAt(String time) {
    return 'طُلب الساعة $time';
  }

  @override
  String requestRoom(String room) {
    return 'غرفة $room';
  }

  @override
  String requestStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'مفتوح',
      'IN_PROGRESS': 'قيد التنفيذ',
      'COMPLETED': 'مكتمل',
      'other': 'ملغى',
    });
    return '$_temp0';
  }

  @override
  String get requestTitle => 'طلب ضيف';

  @override
  String requestWantedFor(String time) {
    return 'مطلوب في $time';
  }

  @override
  String get requestsEmpty => 'لا توجد طلبات ضيوف مفتوحة.';

  @override
  String get requestsTitle => 'طلبات الضيوف';

  @override
  String get reservationComplete => 'انتهى';

  @override
  String get reservationNoShow => 'لم يحضر';

  @override
  String get reservationNotes => 'ملاحظات الضيف';

  @override
  String reservationParty(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count ضيف',
      many: '$count ضيفًا',
      few: '$count ضيوف',
      two: 'ضيفان',
      one: 'ضيف واحد',
      zero: 'بدون ضيوف',
    );
    return '$_temp0';
  }

  @override
  String reservationRoom(String room) {
    return 'غرفة $room';
  }

  @override
  String get reservationSeat => 'إجلاس';

  @override
  String reservationStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'CONFIRMED': 'مؤكد',
      'SEATED': 'على الطاولة',
      'COMPLETED': 'انتهى',
      'NO_SHOW': 'لم يحضر',
      'other': 'ملغى',
    });
    return '$_temp0';
  }

  @override
  String get reservationTitle => 'حجز';

  @override
  String reservationWhen(String date, String time) {
    return '$date الساعة $time';
  }

  @override
  String get restaurantEmpty => 'لا توجد حجوزات في هذا اليوم.';

  @override
  String get restaurantNextDay => 'اليوم التالي';

  @override
  String get restaurantPreviousDay => 'اليوم السابق';

  @override
  String restaurantSeats(String booked, String seats) {
    return '$booked من $seats مقعدًا محجوز';
  }

  @override
  String get restaurantTitle => 'حجوزات المطعم';

  @override
  String get signinEmail => 'بريد العمل';

  @override
  String get signinFailed => 'البريد أو كلمة المرور غير صحيحة.';

  @override
  String get signinMfaHint => 'أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة.';

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

  @override
  String get taskComplete => 'تم الإنجاز';

  @override
  String taskDue(String time) {
    return 'الموعد النهائي $time';
  }

  @override
  String taskPartOf(String title) {
    return 'ضمن: $title';
  }

  @override
  String get taskPause => 'إيقاف مؤقت';

  @override
  String get taskPauseReason => 'لماذا توقف العمل مؤقتًا؟';

  @override
  String taskPriority(String priority) {
    String _temp0 = intl.Intl.selectLogic(priority, {
      'LOW': 'أولوية منخفضة',
      'HIGH': 'أولوية عالية',
      'URGENT': 'عاجلة',
      'other': 'أولوية عادية',
    });
    return '$_temp0';
  }

  @override
  String get taskReject => 'اعتذار';

  @override
  String get taskRejectReason => 'لماذا تعتذر عن المهمة؟';

  @override
  String get taskResume => 'استئناف';

  @override
  String get taskStart => 'ابدأ';

  @override
  String taskStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'NEW': 'جديدة',
      'ASSIGNED': 'مسندة إليك',
      'ACCEPTED': 'مقبولة',
      'IN_PROGRESS': 'قيد التنفيذ',
      'PAUSED': 'متوقفة مؤقتًا',
      'DONE': 'منجزة',
      'other': 'ملغاة',
    });
    return '$_temp0';
  }

  @override
  String get taskTitle => 'مهمة';

  @override
  String get tasksEmpty => 'لا توجد مهام مفتوحة لك.';

  @override
  String get tasksTitle => 'مهامي';

  @override
  String workStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'مفتوح',
      'IN_PROGRESS': 'قيد التنفيذ',
      'RESOLVED': 'تم الحل',
      'other': 'ملغى',
    });
    return '$_temp0';
  }

  @override
  String get workTasks => 'المهام';

  @override
  String get workTitle => 'العمل';
}

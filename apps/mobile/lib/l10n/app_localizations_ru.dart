// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Russian (`ru`).
class AppLocalizationsRu extends AppLocalizations {
  AppLocalizationsRu([String locale = 'ru']) : super(locale);

  @override
  String get appTitle => 'Hotella';

  @override
  String get commonError => 'Что-то пошло не так. Попробуйте ещё раз.';

  @override
  String get commonLanguage => 'Язык';

  @override
  String get commonOffline =>
      'Нет подключения. Повторите, когда связь появится.';

  @override
  String get homeNoSections => 'В этом отеле вам пока ничего не назначено.';

  @override
  String get homeProperty => 'Отель';

  @override
  String get homeSectionAlerts => 'Оповещения';

  @override
  String get homeSectionRequests => 'Запросы гостей';

  @override
  String get homeSectionRestaurant => 'Бронирования ресторана';

  @override
  String get homeSectionTasks => 'Мои задачи';

  @override
  String homeSections(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count раздела доступны вам',
      many: '$count разделов доступны вам',
      few: '$count раздела доступны вам',
      one: '$count раздел доступен вам',
    );
    return '$_temp0';
  }

  @override
  String get homeSignOut => 'Выйти';

  @override
  String homeWelcome(String name) {
    return 'Здравствуйте, $name';
  }

  @override
  String get homeWelcomePlain => 'Здравствуйте';

  @override
  String get hotelChange => 'Сменить отель';

  @override
  String get hotelCode => 'Код отеля';

  @override
  String get hotelContinue => 'Продолжить';

  @override
  String get hotelIntro => 'Введите код отеля, который вам дал руководитель.';

  @override
  String get hotelNotFound =>
      'Отель с таким кодом не найден. Уточните код у руководителя.';

  @override
  String get hotelTitle => 'Ваш отель';

  @override
  String get signinEmail => 'Рабочая почта';

  @override
  String get signinFailed => 'Неверная почта или пароль.';

  @override
  String get signinMfaHint =>
      'Введите 6-значный код из приложения-аутентификатора.';

  @override
  String get signinMfaTitle => 'Код подтверждения';

  @override
  String get signinPassword => 'Пароль';

  @override
  String get signinSubmit => 'Войти';

  @override
  String signinTitle(String hotel) {
    return 'Вход в $hotel';
  }

  @override
  String get signinVerify => 'Подтвердить';
}

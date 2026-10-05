// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Russian (`ru`).
class AppLocalizationsRu extends AppLocalizations {
  AppLocalizationsRu([String locale = 'ru']) : super(locale);

  @override
  String get alertAcknowledge => 'Принять к сведению';

  @override
  String alertLastSeen(String time) {
    return 'Последний раз в $time';
  }

  @override
  String get alertResolution => 'Что было сделано?';

  @override
  String get alertResolve => 'Решить';

  @override
  String alertSeen(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Замечено $count раза',
      many: 'Замечено $count раз',
      few: 'Замечено $count раза',
      one: 'Замечено $count раз',
    );
    return '$_temp0';
  }

  @override
  String alertSeverity(String severity) {
    String _temp0 = intl.Intl.selectLogic(severity, {
      'CRITICAL': 'Критично',
      'WARNING': 'Предупреждение',
      'other': 'Информация',
    });
    return '$_temp0';
  }

  @override
  String alertStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Открыто',
      'ACKNOWLEDGED': 'Принято к сведению',
      'other': 'Решено',
    });
    return '$_temp0';
  }

  @override
  String alertType(String type) {
    String _temp0 = intl.Intl.selectLogic(type, {
      'SLA_RESPONSE_BREACHED': 'Работу никто не взял',
      'SLA_AT_RISK': 'Срок работы подходит к концу',
      'SLA_RESOLUTION_BREACHED': 'Срок работы истёк',
      'CHANNEL_UNHEALTHY': 'Канал сообщений гостям не работает',
      'AI_BUDGET_EXHAUSTED': 'Бюджет ИИ исчерпан',
      'TELEMETRY_ALARM': 'Тревога датчиков здания',
      'other': 'Требует внимания',
    });
    return '$_temp0';
  }

  @override
  String get alertsEmpty => 'Нет открытых оповещений.';

  @override
  String get alertsTitle => 'Оповещения';

  @override
  String get appTitle => 'Hotella';

  @override
  String get commonCancel => 'Отмена';

  @override
  String get commonError => 'Что-то пошло не так. Попробуйте ещё раз.';

  @override
  String get commonLanguage => 'Язык';

  @override
  String get commonOffline => 'Нет подключения. Повторите, когда связь появится.';

  @override
  String get commonRetry => 'Повторить';

  @override
  String get commonSave => 'Сохранить';

  @override
  String commonSavedAt(String time) {
    return 'Нет связи: показаны данные, сохранённые в $time.';
  }

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
  String get hotelNotFound => 'Отель с таким кодом не найден. Уточните код у руководителя.';

  @override
  String get hotelTitle => 'Ваш отель';

  @override
  String get inboxEmpty => 'Уведомлений пока нет.';

  @override
  String get inboxTitle => 'Уведомления';

  @override
  String requestAskedAgain(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Повторно запрошено $count раза',
      many: 'Повторно запрошено $count раз',
      few: 'Повторно запрошено $count раза',
      one: 'Повторно запрошено $count раз',
    );
    return '$_temp0';
  }

  @override
  String requestAskedAt(String time) {
    return 'Запрошено в $time';
  }

  @override
  String requestRoom(String room) {
    return 'Номер $room';
  }

  @override
  String requestStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Открыт',
      'IN_PROGRESS': 'В работе',
      'COMPLETED': 'Выполнен',
      'other': 'Отменён',
    });
    return '$_temp0';
  }

  @override
  String get requestTitle => 'Запрос гостя';

  @override
  String requestWantedFor(String time) {
    return 'Нужно к $time';
  }

  @override
  String get requestsEmpty => 'Нет открытых запросов гостей.';

  @override
  String get requestsTitle => 'Запросы гостей';

  @override
  String get reservationComplete => 'Завершить';

  @override
  String get reservationNoShow => 'Неявка';

  @override
  String get reservationNotes => 'Пожелания гостя';

  @override
  String reservationParty(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count гостя',
      many: '$count гостей',
      few: '$count гостя',
      one: '$count гость',
    );
    return '$_temp0';
  }

  @override
  String reservationRoom(String room) {
    return 'Номер $room';
  }

  @override
  String get reservationSeat => 'Посадить';

  @override
  String reservationStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'CONFIRMED': 'Подтверждено',
      'SEATED': 'Гости за столом',
      'COMPLETED': 'Завершено',
      'NO_SHOW': 'Неявка',
      'other': 'Отменено',
    });
    return '$_temp0';
  }

  @override
  String get reservationTitle => 'Бронирование';

  @override
  String reservationWhen(String date, String time) {
    return '$date в $time';
  }

  @override
  String get restaurantEmpty => 'На этот день бронирований нет.';

  @override
  String get restaurantNextDay => 'Следующий день';

  @override
  String get restaurantPreviousDay => 'Предыдущий день';

  @override
  String restaurantSeats(String booked, String seats) {
    return 'Забронировано мест: $booked из $seats';
  }

  @override
  String get restaurantTitle => 'Бронирования ресторана';

  @override
  String get signinEmail => 'Рабочая почта';

  @override
  String get signinFailed => 'Неверная почта или пароль.';

  @override
  String get signinMfaHint => 'Введите 6-значный код из приложения-аутентификатора.';

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

  @override
  String get taskComplete => 'Выполнено';

  @override
  String taskDue(String time) {
    return 'Срок: $time';
  }

  @override
  String taskPartOf(String title) {
    return 'Часть работы: $title';
  }

  @override
  String get taskPause => 'Приостановить';

  @override
  String get taskPauseReason => 'Почему Вы приостанавливаете?';

  @override
  String taskPriority(String priority) {
    String _temp0 = intl.Intl.selectLogic(priority, {
      'LOW': 'Низкий приоритет',
      'HIGH': 'Высокий приоритет',
      'URGENT': 'Срочно',
      'other': 'Обычный приоритет',
    });
    return '$_temp0';
  }

  @override
  String get taskReject => 'Отказаться';

  @override
  String get taskRejectReason => 'Почему Вы отказываетесь?';

  @override
  String get taskResume => 'Продолжить';

  @override
  String get taskStart => 'Начать';

  @override
  String taskStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'NEW': 'Новая',
      'ASSIGNED': 'Назначена Вам',
      'ACCEPTED': 'Принята',
      'IN_PROGRESS': 'В работе',
      'PAUSED': 'Приостановлена',
      'DONE': 'Выполнена',
      'other': 'Отменена',
    });
    return '$_temp0';
  }

  @override
  String get taskTitle => 'Задача';

  @override
  String get tasksEmpty => 'У Вас нет открытых задач.';

  @override
  String get tasksTitle => 'Мои задачи';

  @override
  String workStatus(String status) {
    String _temp0 = intl.Intl.selectLogic(status, {
      'OPEN': 'Открыта',
      'IN_PROGRESS': 'В работе',
      'RESOLVED': 'Решена',
      'other': 'Отменена',
    });
    return '$_temp0';
  }

  @override
  String get workTasks => 'Задачи';

  @override
  String get workTitle => 'Работа';
}

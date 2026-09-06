import type { Catalog } from "./types.js";

// Russian catalog (REQ-013 §5 seed table). CONTENT-BA owns message-catalog
// COPY per decisions/0002; this seed is the minimal functional copy the
// /start and /lang flows themselves need (REQ-013's own scope statement),
// structurally identical to REQ-001a's precedent on the site side.
export const ru = {
  start: {
    greeting: "Это бот AI Qadam Events.",
    noActiveChapters: "Отделения пока недоступны.",
  },
  chapter: {
    prompt: "Выберите отделение.",
  },
  // Placeholder/provisional wording (REQ-014 design §1) — carries an
  // explicit "(v1)" version identifier per AC4; not final legal copy.
  consent: {
    prompt:
      "Бот AI Qadam Events сохраняет ваш Telegram ID, имя пользователя и язык интерфейса для регистрации на мероприятия и связи с вами. Эта формулировка предварительная (v1) и будет заменена после согласования с ответственным лицом.",
    agree: "Согласен",
  },
  help: {
    body: "Этот бот ведёт сообщество AI Qadam. По вопросам обращайтесь к организаторам вашего отделения. (Плейсхолдер: точные контакты и ссылка на сообщество ещё не определены.)",
  },
  lang: {
    prompt: "Выберите язык интерфейса.",
    confirmed: "Язык интерфейса: русский.",
    noProfile: "Профиль не найден. Язык не сохранён — отправьте /start, чтобы начать.",
  },
  // Placeholder/provisional wording (REQ-015 design §1-§6) — CONTENT-BA owns
  // final copy per decisions/0002; this is the minimal functional wording
  // the venue CRUD flow needs.
  venue: {
    notAuthorized: "У вас нет прав на это действие.",
    notFound: "Площадка не найдена.",
    createUsage:
      "Отправьте /venue_new и на следующих строках укажите поля:\nname: ...\naddress: ...\nyandex: ...\ngoogle: ...\ncapacity: ...\nlat: ... (необязательно)\nlon: ... (необязательно)\nnotes: ... (необязательно)",
    missingFieldsPrefix: "Не заполнены обязательные поля:",
    createSuccessPrefix: "Площадка создана, id:",
    completeNudge:
      "Добавьте координаты позже командой /venue_edit <id>, чтобы ссылка на карте была точной.",
    editUsageNoId: "Укажите id площадки: /venue_edit <id>",
    editCurrentPrefix: "Текущие значения (отправьте /venue_edit <id> и изменённые поля):",
    editSuccessPrefix: "Площадка обновлена, изменены поля:",
    deleteUsageNoId: "Укажите id площадки: /venue_delete <id>",
    deleteSuccessPrefix: "Площадка удалена:",
    deleteRefusedFutureEvent:
      "Нельзя удалить площадку: на неё запланировано предстоящее мероприятие.",
    listEmpty: "Площадок пока нет.",
    listHeader: "Площадки вашего отделения:",
  },
  // Placeholder/provisional wording (REQ-016 design §9) — CONTENT-BA owns
  // final copy per decisions/0002; this is the minimal functional wording
  // the event CRUD/publish/cancel/deep-link flow needs.
  event: {
    notAuthorized: "У вас нет прав на это действие.",
    notFound: "Мероприятие не найдено.",
    createUsage:
      "Отправьте /event_new и на следующих строках укажите поля:\ntitle: ...\ndescription: ...\nformat: meetup|fail_stories|workshop|hackathon\nvenue: ... (необязательно)\nstarts: ISO-время начала\nends: ISO-время окончания\nregistration_closes: ... (необязательно)\ncapacity: ...\nrequires_invite: true|false (необязательно)\nrequires_approval: true|false (необязательно)\ncover_file_id: ... (необязательно)",
    missingFieldsPrefix: "Не заполнены или некорректны обязательные поля:",
    createSuccessPrefix: "Мероприятие создано (черновик), id:",
    editUsageNoId: "Укажите id мероприятия: /event_edit <id>",
    editCurrentPrefix: "Текущие значения (отправьте /event_edit <id> и изменённые поля):",
    editSuccessPrefix: "Мероприятие обновлено, изменены поля:",
    publishUsageNoId: "Укажите id мероприятия: /event_publish <id>",
    publishSuccessPrefix: "Мероприятие опубликовано:",
    publishRefusedNotDraft: "Опубликовать можно только черновик мероприятия.",
    publishRefusedMissingFields: "Публикация отклонена. Не заполнены или некорректны:",
    capacityBelowAdmittedFloor:
      "Вместимость нельзя снизить ниже числа уже подтверждённых участников:",
    cancelUsageNoId: "Укажите id мероприятия: /event_cancel <id>",
    cancelSuccessPrefix: "Мероприятие отменено:",
    cancelRefusedNotPublished: "Отменить можно только опубликованное мероприятие.",
    agendaRefusedDoorsAfterStart:
      "Пункт открытия дверей не может быть позже начала мероприятия:",
    agendaRefusedItemAfterEnd: "Пункт программы не может быть позже окончания мероприятия:",
    agendaRefusedMultipleDoors: "В программе может быть только один пункт открытия дверей.",
    deepLinkNotAvailable: "Это мероприятие сейчас недоступно.",
    deepLinkSeeUpcoming: "Посмотрите ближайшие мероприятия: /events",
    deepLinkPublishedPlaceholder: "Мероприятие:",
  },
  // NEW, REQ-017: /events upcoming list + event card copy.
  events: {
    listHeader: "Ближайшие мероприятия:",
    listRowSeatsLeft: "Свободных мест:",
    listRowWaitlistOpen: "Лист ожидания открыт",
    followCityInvite:
      "Пока нет ближайших мероприятий в вашем отделении. Следите за обновлениями — новые мероприятия появятся здесь.",
    cardVenueLabel: "Место проведения:",
    cardMapYandex: "Яндекс.Карты:",
    cardMapGoogle: "Google Карты:",
    cardAgendaLabel: "Программа:",
    cardSeatsLeft: "Свободных мест:",
    cardWaitlistOpen: "Лист ожидания открыт",
    cardCta:
      "Ответьте на это сообщение, чтобы зарегистрироваться — регистрация через бота пока не реализована.",
  },
  // Placeholder/provisional wording (REQ-018 design §5) — CONTENT-BA owns
  // final copy per decisions/0002.
  staff: {
    notAuthorized: "У вас нет прав на это действие.",
    usageNoArgs:
      "Отправьте /staff_add <event_id> <tg_username> (или /staff_remove) двумя параметрами.",
    eventNotFound: "Мероприятие не найдено.",
    userNotFound: "Пользователь не найден.",
    alreadyAssigned: "Этот пользователь уже назначен на встречу этого мероприятия.",
    notAssigned: "Этот пользователь не назначен на встречу этого мероприятия.",
    addSuccessPrefix: "Назначен(а) на встречу мероприятия:",
    removeSuccessPrefix: "Снят(а) со встречи мероприятия:",
    notificationFailedNote: " (не удалось отправить уведомление пользователю)",
    assignmentNotificationBody:
      "Вас назначили на встречу гостей (check-in) для мероприятия «{event}». Ваша задача на входе: поприветствовать гостя, спросить имя и подтвердить его в списке участников.",
    removalNotificationBody:
      "Организатор снял(а) вас со встречи гостей (check-in) для мероприятия «{event}». Доступ к этой функции для данного мероприятия больше недоступен.",
  },
  // Placeholder/provisional wording (REQ-018 design §5) — CONTENT-BA owns
  // final copy per decisions/0002. Authorization-only stub (design §0.3):
  // no check-in business logic exists yet (REQ-028/029's scope).
  checkin: {
    usageNoId: "Укажите id мероприятия: /checkin <event_id>",
    notFound: "Мероприятие не найдено.",
    notAuthorized: "У вас нет прав встречать гостей на этом мероприятии.",
    authorizedStub:
      "Вы авторизованы для встречи гостей мероприятия «{event}». Сканирование и регистрация прихода пока не реализованы в этой версии бота.",
  },
} satisfies Catalog;

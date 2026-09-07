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
    cancelledNotificationHeader: "Это мероприятие отменено:",
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
  // Placeholder/provisional wording (REQ-018 design §5, REQ-028 design §5) —
  // CONTENT-BA owns final copy per decisions/0002.
  checkin: {
    usageNoId: "Укажите id мероприятия: /checkin <event_id>",
    notFound: "Мероприятие не найдено.",
    notAuthorized: "У вас нет прав встречать гостей на этом мероприятии.",
    listHeader: "Мероприятие: {event}\nОтметилось: {checkedIn} / {total}",
    listEmpty: "На этом мероприятии пока нет подтверждённых участников.",
    searchNoMatches: "По этому запросу никто не найден.",
    searchHint: "Чтобы найти гостя, отправьте /checkin <event_id> <имя>.",
    searchTruncatedNote: "И ещё {count}. Уточните запрос, чтобы сузить список.",
    checkedInGlyph: "✅",
    notCheckedInGlyph: "▫️",
    pageIndicator: "{current} / {total}",
    refusedNotAdmitted: "Отметить нельзя: статус этого участника изменился.",
    noNameFallback: "Без имени",
  },
  // Placeholder/provisional wording (REQ-029 design §7) — CONTENT-BA owns
  // final copy per decisions/0002.
  checkinQr: {
    unknownToken: "Этот код регистрации не распознан.",
    eventEnded: "Это мероприятие уже завершилось.",
    notStaff: "У вас нет прав встречать гостей на этом мероприятии.",
    alreadyCheckedIn: "Уже отмечен(а) в {at}, отметил(а) {by}.",
    refusedWaitlisted: "Отметить нельзя: участник в списке ожидания, не подтверждён.",
    refusedRequested: "Отметить нельзя: регистрация участника ещё ожидает подтверждения.",
    refusedWithdrawn: "Отметить нельзя: участник отменил регистрацию.",
    refusedRejected: "Отметить нельзя: регистрация участника отклонена.",
    overrideButtonLabel: "Переопределить: подтвердить и отметить",
    overrideNotAuthorized: "Переопределить может только организатор.",
    overrideNotApplicable: "Для этой регистрации переопределение больше не требуется.",
    overrideSuccess: "Подтверждён(а) и отмечен(а): {name}{company}. Уже отметилось: {checkedIn}.",
    successHeader: "Отмечен(а): {name}{company}. Уже отметилось: {checkedIn}.",
  },
  // Placeholder/provisional wording (REQ-019 design §5) — CONTENT-BA owns
  // final copy per decisions/0002.
  profile: {
    startFirst: "Сначала отправьте /start.",
    editHint: "Изменить: /profile_edit. Сменить отделение: /profile_chapter.",
    editRejectedPrefix: "Не удалось сохранить, проверьте поля:",
    invalidAnswerPrefix: "Не удалось распознать ответ. ",
    invalidEmailFormat: "Некорректный формат email. Введите email ещё раз или нажмите «Пропустить».",
    completedNotice: "Анкета заполнена. /profile — посмотреть профиль.",
    chapterPrompt: "Выберите отделение.",
    chapterUpdatedPrefix: "Отделение изменено:",
    skipButton: "Пропустить",
    shareContactButton: "Поделиться номером",
    studentYes: "Да",
    studentNo: "Нет",
    experienceUser: "Пользователь",
    experienceBuilder: "Разработчик",
    experienceAdvanced: "Продвинутый",
    experienceExpert: "Эксперт",
    promptFirstName: "Как вас зовут (имя)?",
    promptLastName: "Ваша фамилия?",
    promptCompany: "Где вы работаете (компания)?",
    promptPosition: "Какая у вас должность?",
    promptIsStudent: "Вы студент?",
    promptExperienceLevel: "Оцените свой уровень опыта.",
    promptPhone: "Поделитесь номером телефона (или нажмите «Пропустить»).",
    promptEmail: "Ваш email? (или нажмите «Пропустить»)",
    promptGithub: "Ссылка на GitHub? (или нажмите «Пропустить»)",
    promptLinkedin: "Ссылка на LinkedIn? (или нажмите «Пропустить»)",
    promptSite: "Ссылка на сайт? (или нажмите «Пропустить»)",
    labelFirstName: "Имя:",
    labelLastName: "Фамилия:",
    labelCompany: "Компания:",
    labelPosition: "Должность:",
    labelIsStudent: "Студент:",
    labelExperienceLevel: "Уровень опыта:",
    labelPhone: "Телефон:",
    labelEmail: "Email:",
    labelGithub: "GitHub:",
    labelLinkedin: "LinkedIn:",
    labelSite: "Сайт:",
    fieldNotSet: "не указано",
    fieldSkipped: "пропущено",
  },
  // Placeholder/provisional wording (REQ-020 design §8) — CONTENT-BA owns
  // final copy per decisions/0002.
  registration: {
    registerButton: "Зарегистрироваться",
    confirmedPrefix: "Вы зарегистрированы!",
    whatNext: "Что дальше: ближе к мероприятию вы получите код для входа.",
    waitlistedPrefix: "Вы в листе ожидания на:",
    waitlistedPositionPrefix: "Ваша позиция:",
    waitlistedWhatNext: "Что дальше: вы автоматически продвинетесь в списке, если освободятся места.",
    alreadyRegisteredPrefix: "Вы уже зарегистрированы на это мероприятие. Статус:",
    statusAdmitted: "подтверждено",
    statusWaitlisted: "лист ожидания",
    statusRequested: "запрошено",
    statusRejected: "отклонено",
    statusWithdrawn: "отменено",
    refusedCancelled: "Это мероприятие отменено.",
    refusedFinished: "Это мероприятие уже завершилось.",
    refusedClosed: "Регистрация на это мероприятие закрыта.",
    refusedRequiresInvite: "Это мероприятие только по приглашениям.",
    refusedRequiresApproval: "Для этого мероприятия требуется подтверждение организатора.",
  },
  // NEW, REQ-022: /withdraw <event_id>. Placeholder/minimal functional copy
  // per decisions/0002 (CONTENT-BA owns final wording).
  withdraw: {
    usageNoId: "Укажите id мероприятия: /withdraw <event_id>",
    confirmPrompt: "Отменить регистрацию на это мероприятие?",
    confirmButton: "Да, отменить",
    cancelButton: "Нет, оставить место",
    confirmedReply: "Регистрация отменена. Место освобождено.",
    cancelledReply: "Хорошо, ваша регистрация не изменена.",
    refusedCheckedIn: "Вы уже отметились на этом мероприятии — историю посещения нельзя изменить.",
    refusedNotEligible: "Эта регистрация уже отменена или отклонена.",
    refusedNotFound: "Регистрация не найдена.",
  },
  // NEW, REQ-023: waitlist auto-promotion notification. Placeholder/minimal
  // functional copy per decisions/0002 (CONTENT-BA owns final wording).
  // NEW, REQ-024: /my registrations view. Placeholder/minimal functional
  // copy per decisions/0002 (CONTENT-BA owns final wording).
  my: {
    header: "Ваши регистрации:",
    emptyState: "У вас пока нет регистраций. Посмотрите /events, чтобы найти мероприятие.",
    withdrawButton: "Отменить регистрацию",
  },
  promotion: {
    admittedPrefix: "Освободилось место — вы участвуете!",
    whatNext: "Что дальше: ближе к мероприятию вы получите код для входа.",
    qrLabel: "Ваш код для входа:",
  },
  // NEW, REQ-026: напоминания T-24ч и T-3ч. Предварительный/минимальный
  // текст согласно decisions/0002 (окончательный текст утверждает CONTENT-BA).
  reminder24h: {
    prompt: "Вы все еще планируете прийти на это мероприятие?",
    confirmButton: "Я буду",
    declineButton: "Не смогу прийти",
    reconfirmedReply: "Отлично, до встречи!",
  },
  reminder3h: {
    header: "Скоро начинаем! Как добраться:",
    doorsLabel: "Открытие дверей:",
    startLabel: "Начало:",
  },
} satisfies Catalog;

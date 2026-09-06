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
} satisfies Catalog;

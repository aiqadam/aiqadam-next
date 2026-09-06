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
} satisfies Catalog;

import Image from "next/image";

const TALKS = [
  {
    img: "/images/speaker-ustinov.jpg",
    who: "Антон Устинов",
    role: "UZ",
    topic: "AI-агенты в комплаенсе",
    desc: "Мультиагентная архитектура, автоматизирующая >90% KYC / AML.",
  },
  {
    img: "/images/speaker-rakhmatov.jpg",
    who: "Шохзод Рахматов",
    role: "UZ · BEELAB",
    topic: "Взлом с помощью AI",
    desc: "Offensive security на практике. AppSec-инженер.",
  },
  {
    img: "/images/speaker-naslediva.jpg",
    who: "Вероника Наследова",
    role: "UAE · SAIDE",
    topic: "От демо до продукта",
    desc: "Архитектура, ошибки, метрики. CEO и основатель.",
  },
  {
    img: "/images/speaker-kulagin.jpg",
    who: "Алексей Кулагин",
    role: "UZ · EPAM",
    topic: "AI-бот с памятью",
    desc: "Как проверить идею за $5. Engineering Manager.",
  },
];

export default function Events() {
  return (
    <section id="events">
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">События</p>
          <h2>Глубина, а не «AI для начинающих».</h2>
          <p className="lede">
            Семь докладов за два митапа: мультиагентные системы в KYC/AML,
            offensive security, путь от прототипа до продакшена, governance
            для роёв агентов. Восемь человек сами вызвались выступить.
          </p>
        </div>
        <div className="meetup-tabs rv">
          <span className="on">MEETUP #1 · 25.04.2026</span>
          <span>MEETUP #2 · 20.06.2026</span>
          <span>FAIL STORIES · 26.08.2026</span>
        </div>
        <div className="talks rv">
          {TALKS.map((t) => (
            <article className="talk" key={t.who}>
              <div className="ph">
                <Image src={t.img} alt="" width={360} height={360} />
              </div>
              <div className="tb">
                <div className="who">{t.who}</div>
                <div className="role">{t.role}</div>
                <div className="topic">{t.topic}</div>
                <p
                  style={{
                    fontSize: "12.5px",
                    color: "var(--muted)",
                    margin: "9px 0 0",
                  }}
                >
                  {t.desc}
                </p>
              </div>
            </article>
          ))}
        </div>
        <p className="source-note rv" style={{ marginTop: 20 }}>
          Митап #2: Павел Попов — от чат-бота к оркестру агентов · Алекс
          Жураев — low-code AI для операционной устойчивости · Константин
          Гусь — governance для роёв агентов.
        </p>
      </div>
    </section>
  );
}

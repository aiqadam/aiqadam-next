const METRICS = [
  { n: "300", l: "регистраций на два митапа", s: "158 + 142" },
  { n: "100+", l: "человек в зале каждый раз", s: "места кончаются за 4 дня" },
  { n: "+78", l: "NPS", s: "0 детракторов · 27 ответов" },
  { n: "80+", l: "компаний: IT, банки, телеком", s: "по данным регистраций" },
  { n: "2", l: "страны: Узбекистан и Казахстан", s: "600+ в чатах сообщества" },
];

export default function Metrics() {
  return (
    <section className="metrics" id="proof">
      <div className="wrap">
        <div className="metrics-grid rv">
          {METRICS.map((m) => (
            <div className="metric" key={m.l}>
              <div className="n">{m.n}</div>
              <div className="l">{m.l}</div>
              <div className="s">{m.s}</div>
            </div>
          ))}
        </div>
        <p className="source-note rv">
          Данные митапов #1 (25.04.2026) и #2 (20.06.2026). Опросы после
          событий, выборка указана под каждой цифрой.
        </p>
      </div>
    </section>
  );
}

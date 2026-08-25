const STREAMS = [
  {
    status: "работает",
    statusClass: "live",
    title: "События",
    desc: "Митапы, Fail Stories, хакатоны — двигатель всей экосистемы.",
  },
  {
    status: "в работе",
    statusClass: "prog",
    title: "Люди",
    desc: "Социальные проекты сообщества. Первый — Suhbat, анонимная поддержка с участием AI.",
  },
  {
    status: "в планах",
    statusClass: "",
    title: "Образование",
    desc: "Честная оценка AI-навыков и программы, собранные практиками.",
  },
  {
    status: "в планах",
    statusClass: "",
    title: "Акселератор",
    desc: "Поддержка стартапов: инженерия, гранты, доступ к инвесторам.",
  },
];

export default function Streams() {
  return (
    <section id="streams" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">Направления</p>
          <h2>Четыре направления, одно ядро.</h2>
          <p className="lede">
            Мы показываем статус честно: работает, в работе или в планах.
            Ничего из этого не продаётся как готовое, пока оно не готово.
          </p>
        </div>
        <div className="streams rv">
          {STREAMS.map((s) => (
            <div className="stream" key={s.title}>
              <span
                className={`status ${s.statusClass}`.trim()}
                style={{ alignSelf: "flex-start" }}
              >
                {s.status}
              </span>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
        <div className="foundation rv">
          <span className="ftitle">AI Qadam Build</span>
          <p>
            Не пятое направление, а фундамент под остальными четырьмя:
            открытый код, которым сообщество владеет и управляет само. MIT /
            Apache-2.0, без платных заглушек на SSO и аудит-логах.
          </p>
          <a href="https://build.aiqadam.org">build.aiqadam.org →</a>
        </div>
      </div>
    </section>
  );
}

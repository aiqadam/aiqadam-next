const CHAPTERS = [
  {
    name: "Узбекистан",
    desc: "Хоум-база. Здесь живёт Global.",
    status: "активен",
    statusClass: "live",
  },
  {
    name: "Казахстан",
    desc: "Свой митап в Алматы 20 июня — в один день с Ташкентом.",
    status: "активен",
    statusClass: "live",
  },
  {
    name: "Таджикистан",
    desc: "Следующий в дорожной карте.",
    status: "в планах",
    statusClass: "",
  },
  {
    name: "Кыргызстан",
    desc: "Дальше — весь тюркский мир.",
    status: "в планах",
    statusClass: "",
  },
];

export default function MapSection() {
  return (
    <section className="map-sect" id="map">
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">География</p>
          <h2>Не франшиза, а федерация.</h2>
          <p className="lede">
            Всё, что можно стандартизировать — бренд, методология, форматы,
            инфраструктура — приходит из центра. Всё локальное — язык,
            партнёры, контекст — остаётся у местной команды.
          </p>
        </div>
        <div className="map-layout">
          <div className="map-frame rv">
            <svg
              viewBox="0 0 820 430"
              role="img"
              aria-label="Карта присутствия AI Qadam: Ташкент и Алматы активны, Душанбе и Бишкек в планах"
            >
              <defs>
                <pattern
                  id="grid"
                  width="26"
                  height="26"
                  patternUnits="userSpaceOnUse"
                >
                  <circle cx="1" cy="1" r="1" fill="#2A3335" />
                </pattern>
              </defs>
              <rect width="820" height="430" fill="url(#grid)" opacity=".55" />

              <polyline
                className="trace"
                points="300,232 400,232 440,192 596,192 630,158"
              />
              <polyline
                className="trace-planned"
                points="300,232 300,300 340,340 402,340"
              />
              <polyline
                className="trace-planned"
                points="440,192 500,192 540,152 560,152"
              />

              {/* Tashkent */}
              <circle className="node-ring" cx="300" cy="232" r="9" />
              <circle className="node-ring b" cx="300" cy="232" r="9" />
              <circle className="node-live" cx="300" cy="232" r="7" />
              <text className="node-label" x="300" y="272" textAnchor="middle">
                ТАШКЕНТ
              </text>
              <text className="node-sub" x="300" y="288" textAnchor="middle">
                ХОУМ-БАЗА · 2 МИТАПА
              </text>

              {/* Almaty */}
              <circle className="node-ring" cx="630" cy="158" r="9" />
              <circle className="node-live" cx="630" cy="158" r="7" />
              <text className="node-label" x="630" y="132" textAnchor="middle">
                АЛМАТЫ
              </text>
              <text className="node-sub" x="630" y="116" textAnchor="middle">
                ЧАПТЕР KZ · С 20.06.2026
              </text>

              {/* Dushanbe */}
              <circle className="node-soon" cx="402" cy="340" r="6" />
              <text
                className="node-label"
                x="402"
                y="368"
                textAnchor="middle"
                opacity=".65"
              >
                ДУШАНБЕ
              </text>
              <text className="node-sub" x="402" y="384" textAnchor="middle">
                В ПЛАНАХ
              </text>

              {/* Bishkek */}
              <circle className="node-soon" cx="560" cy="152" r="6" />
              <text
                className="node-label"
                x="560"
                y="126"
                textAnchor="middle"
                opacity=".65"
              >
                БИШКЕК
              </text>
              <text className="node-sub" x="560" y="110" textAnchor="middle">
                В ПЛАНАХ
              </text>

              <polyline
                className="trace-planned"
                points="630,158 720,158 760,120"
              />
              <text className="node-sub" x="768" y="112" opacity=".8">
                ТЮРКСКИЙ МИР →
              </text>
            </svg>
          </div>
          <div className="rv">
            {CHAPTERS.map((c) => (
              <div className="chapter-row" key={c.name}>
                <span className="c-name">{c.name}</span>
                <span className="c-desc">{c.desc}</span>
                <span className={`status ${c.statusClass}`.trim()}>
                  {c.status}
                </span>
              </div>
            ))}
            <div style={{ marginTop: 26 }}>
              <a className="btn btn-ghost" href="#join">
                Запустить чаптер у себя
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

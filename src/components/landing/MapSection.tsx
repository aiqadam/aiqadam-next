import { getTranslations } from "next-intl/server";

const CHAPTERS = [
  { statusClass: "live" },
  { statusClass: "live" },
  { statusClass: "" },
  { statusClass: "" },
];

export default async function MapSection() {
  const t = await getTranslations("MapSection");
  const chapters = CHAPTERS.map((chapter, i) => ({
    ...chapter,
    name: t(`chapter${i + 1}Name`),
    desc: t(`chapter${i + 1}Desc`),
    status: t(`chapter${i + 1}Status`),
  }));
  return (
    <section className="map-sect" id="map">
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h2>{t("title")}</h2>
          <p className="lede">{t("lede")}</p>
        </div>
        <div className="map-layout">
          <div className="map-frame rv">
            <svg
              viewBox="0 0 820 430"
              role="img"
              aria-label={t("svgAriaLabel")}
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
                {t("nodeTashkentLabel")}
              </text>
              <text className="node-sub" x="300" y="288" textAnchor="middle">
                {t("nodeTashkentSub")}
              </text>

              {/* Almaty */}
              <circle className="node-ring" cx="630" cy="158" r="9" />
              <circle className="node-live" cx="630" cy="158" r="7" />
              <text className="node-label" x="630" y="132" textAnchor="middle">
                {t("nodeAlmatyLabel")}
              </text>
              <text className="node-sub" x="630" y="116" textAnchor="middle">
                {t("nodeAlmatySub")}
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
                {t("nodeDushanbeLabel")}
              </text>
              <text className="node-sub" x="402" y="384" textAnchor="middle">
                {t("nodeDushanbeSub")}
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
                {t("nodeBishkekLabel")}
              </text>
              <text className="node-sub" x="560" y="110" textAnchor="middle">
                {t("nodeBishkekSub")}
              </text>

              <polyline
                className="trace-planned"
                points="630,158 720,158 760,120"
              />
              <text className="node-sub" x="768" y="112" opacity=".8">
                {t("turkicWorldLabel")}
              </text>
            </svg>
          </div>
          <div className="rv">
            {chapters.map((c) => (
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
                {t("ctaLaunchChapter")}
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

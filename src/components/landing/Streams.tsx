import { getTranslations } from "next-intl/server";

const STREAMS = [
  { statusClass: "live" },
  { statusClass: "prog" },
  { statusClass: "" },
  { statusClass: "" },
];

export default async function Streams() {
  const t = await getTranslations("Streams");
  const streams = STREAMS.map((stream, i) => ({
    ...stream,
    status: t(`stream${i + 1}Status`),
    title: t(`stream${i + 1}Title`),
    desc: t(`stream${i + 1}Desc`),
  }));
  return (
    <section id="streams" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h2>{t("title")}</h2>
          <p className="lede">{t("lede")}</p>
        </div>
        <div className="streams rv">
          {streams.map((s) => (
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
          <span className="ftitle">{t("foundationTitle")}</span>
          <p>{t("foundationBody")}</p>
          <a href="https://build.aiqadam.org">{t("foundationLink")}</a>
        </div>
      </div>
    </section>
  );
}

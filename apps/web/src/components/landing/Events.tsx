import Image from "next/image";
import { getTranslations } from "next-intl/server";

const TALKS = [
  { img: "/images/speaker-ustinov.jpg" },
  { img: "/images/speaker-rakhmatov.jpg" },
  { img: "/images/speaker-naslediva.jpg" },
  { img: "/images/speaker-kulagin.jpg" },
];

export default async function Events() {
  const t = await getTranslations("Events");
  const talks = TALKS.map((talk, i) => ({
    ...talk,
    who: t(`talk${i + 1}Who`),
    role: t(`talk${i + 1}Role`),
    topic: t(`talk${i + 1}Topic`),
    desc: t(`talk${i + 1}Desc`),
  }));
  return (
    <section id="events">
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h2>{t("title")}</h2>
          <p className="lede">{t("lede")}</p>
        </div>
        <div className="meetup-tabs rv">
          <span className="on">{t("tabMeetup1")}</span>
          <span>{t("tabMeetup2")}</span>
          <span>{t("tabFailStories")}</span>
        </div>
        <div className="talks rv">
          {talks.map((talk) => (
            <article className="talk" key={talk.who}>
              <div className="ph">
                <Image src={talk.img} alt="" width={360} height={360} />
              </div>
              <div className="tb">
                <div className="who">{talk.who}</div>
                <div className="role">{talk.role}</div>
                <div className="topic">{talk.topic}</div>
                <p
                  style={{
                    fontSize: "12.5px",
                    color: "var(--muted)",
                    margin: "9px 0 0",
                  }}
                >
                  {talk.desc}
                </p>
              </div>
            </article>
          ))}
        </div>
        <p className="source-note rv" style={{ marginTop: 20 }}>
          {t("sourceNote")}
        </p>
      </div>
    </section>
  );
}

import { getTranslations } from "next-intl/server";

export default async function Creed() {
  const t = await getTranslations("Creed");
  return (
    <section id="about">
      <div className="wrap creed-grid">
        <div className="rv">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h2>{t("title")}</h2>
          <p className="lede">{t("lede")}</p>
          <div className="creed-list" style={{ marginTop: 34 }}>
            <div>
              <b>{t("principle1Title")}</b>
              <span>{t("principle1Body")}</span>
            </div>
            <div>
              <b>{t("principle2Title")}</b>
              <span>{t("principle2Body")}</span>
            </div>
            <div>
              <b>{t("principle3Title")}</b>
              <span>{t("principle3Body")}</span>
            </div>
            <div>
              <b>{t("principle4Title")}</b>
              <span>{t("principle4Body")}</span>
            </div>
          </div>
        </div>
        <div className="quote rv">
          <p>
            {t.rich("quote", { em: (chunks) => <em>{chunks}</em> })}
          </p>
          <div className="qmeta">{t("quoteMeta")}</div>
        </div>
      </div>
    </section>
  );
}

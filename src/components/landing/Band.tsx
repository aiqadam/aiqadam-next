import { getTranslations } from "next-intl/server";

export default async function Band() {
  const t = await getTranslations("Band");
  return (
    <section className="band">
      <div className="wrap">
        <h2 className="rv">{t("title")}</h2>
        <p
          className="lede rv"
          style={{ marginLeft: "auto", marginRight: "auto", textAlign: "center" }}
        >
          {t("lede")}
        </p>
        <div className="cta-row rv">
          <a className="btn btn-primary" href="https://t.me/ai_qadam_community">
            {t("ctaPrimary")}
          </a>
          <a className="btn btn-ghost" href="mailto:binali.rustamov@aiqadam.org">
            {t("ctaSecondary")}
          </a>
        </div>
      </div>
    </section>
  );
}

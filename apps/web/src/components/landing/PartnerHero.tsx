import { getTranslations } from "next-intl/server";

export default async function PartnerHero() {
  const t = await getTranslations("PartnerHero");
  return (
    <section className="partner-hero" id="top">
      <div className="wrap">
        <div className="hero-inner">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1 dangerouslySetInnerHTML={{ __html: t.raw("title") }} />
          <p className="sub">{t("subtitle")}</p>
          <div className="cta-row">
            <a className="btn btn-primary" href="#tiers">
              {t("ctaPrimary")}
            </a>
            <a
              className="btn btn-ghost"
              href="mailto:binali.rustamov@aiqadam.org"
            >
              {t("ctaSecondary")}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

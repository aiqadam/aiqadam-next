import Image from "next/image";
import { getTranslations } from "next-intl/server";

export default async function Hero() {
  const t = await getTranslations("Hero");
  return (
    <section className="hero" id="top">
      <div className="hero-media">
        <Image src="/images/hero.jpg" alt="" fill priority sizes="100vw" />
      </div>
      <div className="hero-inner">
        <div className="wrap">
          <p className="eyebrow rv">{t("eyebrow")}</p>
          <h1 className="rv">
            {t.rich("title", { em: (chunks) => <em>{chunks}</em> })}
          </h1>
          <p className="sub rv">{t("subtitle")}</p>
          <div className="cta-row rv">
            <a className="btn btn-primary" href="#events">
              {t("ctaPrimary")}
            </a>
            <a className="btn btn-ghost" href="https://t.me/ai_qadam_community">
              {t("ctaSecondary")}
            </a>
          </div>
          <div className="chapters-pills rv">
            <span className="pill active">
              <i className="dot" />
              {t("pillUzbekistan")}
            </span>
            <span className="pill active">
              <i className="dot" />
              {t("pillKazakhstan")}
            </span>
            <span className="pill">
              <i className="dot" />
              {t("pillTajikistan")}
            </span>
            <span className="pill">
              <i className="dot" />
              {t("pillKyrgyzstan")}
            </span>
          </div>
        </div>
      </div>
      <div className="nextev">
        <div className="nextev-in">
          <span className="live">
            <i />
            {t("nextEventLabel")}
          </span>
          <span className="when">{t("nextEventWhen")}</span>
          <span className="what">
            <b>{t("nextEventWhatBold")}</b>
            {t("nextEventWhatRest")}
          </span>
          <a className="go" href="#events">
            {t("nextEventCta")}
          </a>
        </div>
      </div>
    </section>
  );
}

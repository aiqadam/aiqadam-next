import { getTranslations } from "next-intl/server";

export default async function Footer() {
  const t = await getTranslations("Footer");
  return (
    <footer>
      <div className="wrap">
        <div className="f-grid">
          <div className="f-col">
            <a className="brand" href="#top" style={{ marginBottom: 14 }}>
              <img src="https://brand.aiqadam.org/brand/logo-mark.svg" alt="" />
              AI Qadam
            </a>
            <p style={{ margin: 0, maxWidth: "34ch" }}>{t("about")}</p>
          </div>
          <div className="f-col">
            <h4>{t("communityHeading")}</h4>
            <a href="https://t.me/ai_qadam_community">
              {t("communityChatUzbekistan")}
            </a>
            <a href="https://t.me/ai_qadam_kazakhstan">
              {t("communityChatKazakhstan")}
            </a>
            <a href="https://t.me/aiqadam_build">
              {t("communityChatContributors")}
            </a>
          </div>
          <div className="f-col">
            <h4>{t("ecosystemHeading")}</h4>
            <a href="https://build.aiqadam.org">build.aiqadam.org</a>
            <a href="https://flow.aiqadam.org">flow.aiqadam.org</a>
            <a href="https://brand.aiqadam.org">brand.aiqadam.org</a>
            <a href="https://github.com/aiqadam">github.com/aiqadam</a>
          </div>
          <div className="f-col">
            <h4>{t("contactsHeading")}</h4>
            <a href="mailto:binali.rustamov@aiqadam.org">
              binali.rustamov@aiqadam.org
            </a>
            <a href="https://t.me/RETURN_VOID_0">{t("contactsTelegram")}</a>
            <a href="tel:+77085272322">+7 708 527 2322</a>
          </div>
        </div>
        <div className="f-bottom">
          <span>{t("hashtag")}</span>
          <span>{t("licenseCode")}</span>
          <span>{t("licenseContent")}</span>
          <span>{t("licenseBrand")}</span>
          <span style={{ marginLeft: "auto", color: "var(--border-hi)" }}>
            {t("prototypeLabel")}
          </span>
        </div>
      </div>
    </footer>
  );
}

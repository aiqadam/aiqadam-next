import { getTranslations } from "next-intl/server";

export default async function Doors() {
  const t = await getTranslations("Doors");
  return (
    <section
      id="join"
      style={{ borderTop: "1px solid var(--border)", background: "var(--bg2)" }}
    >
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h2>{t("title")}</h2>
          <p className="lede">{t("lede")}</p>
        </div>
        <div className="doors rv">
          <div className="door">
            <div className="dots">
              <i />
              <i />
              <i />
            </div>
            <h3>{t("door1Title")}</h3>
            <p>{t("door1Body")}</p>
            <a href="https://t.me/ai_qadam_community">{t("door1LinkUzbekistan")}</a>
            <br />
            <a href="https://t.me/ai_qadam_kazakhstan">{t("door1LinkKazakhstan")}</a>
            <span className="tag">{t("door1Tag")}</span>
          </div>
          <div className="door">
            <div className="dots">
              <i />
              <i />
              <i />
            </div>
            <h3>{t("door2Title")}</h3>
            <p>{t("door2Body")}</p>
            <a href="https://t.me/RETURN_VOID_0">{t("door2Link")}</a>
            <span className="tag">{t("door2Tag")}</span>
          </div>
          <div className="door">
            <div className="dots">
              <i />
              <i />
              <i />
            </div>
            <h3>{t("door3Title")}</h3>
            <p>{t("door3Body")}</p>
            <a href="https://build.aiqadam.org">{t("door3LinkProjects")}</a>
            <br />
            <a href="https://t.me/aiqadam_build">{t("door3LinkChat")}</a>
            <span className="tag">{t("door3Tag")}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

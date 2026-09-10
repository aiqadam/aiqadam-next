import { getTranslations } from "next-intl/server";

const WELCOME = [1, 2, 3, 4];
const DECLINE = [1, 2, 3, 4, 5, 6];

export default async function PartnerLine() {
  const t = await getTranslations("PartnerLine");
  return (
    <section id="line">
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h2>{t("title")}</h2>
          <p className="lede">{t("lede")}</p>
        </div>
        <div className="line-grid rv">
          <div className="line-col line-yes">
            <h3>{t("welcomeHeading")}</h3>
            <ul>
              {WELCOME.map((i) => (
                <li key={i}>{t(`welcome${i}`)}</li>
              ))}
            </ul>
          </div>
          <div className="line-col line-no">
            <h3>{t("declineHeading")}</h3>
            <ul>
              {DECLINE.map((i) => (
                <li key={i}>{t(`decline${i}`)}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

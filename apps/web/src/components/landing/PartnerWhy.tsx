import { getTranslations } from "next-intl/server";

const WAVES = [1, 2, 3];

export default async function PartnerWhy() {
  const t = await getTranslations("PartnerWhy");
  return (
    <section id="why">
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h2>{t("title")}</h2>
          <p className="lede">{t("lede")}</p>
        </div>
        <div className="waves rv">
          {WAVES.map((i) => (
            <div className="wave" key={i}>
              <div className="wnum">{String(i).padStart(2, "0")}</div>
              <h3>{t(`wave${i}Title`)}</h3>
              <p>{t(`wave${i}Body`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

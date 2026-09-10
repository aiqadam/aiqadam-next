import { getTranslations } from "next-intl/server";

const TIERS = [
  { key: 1, benefits: 3 },
  { key: 2, benefits: 3 },
  { key: 3, benefits: 4 },
];

export default async function ContributionTiers() {
  const t = await getTranslations("ContributionTiers");
  return (
    <section
      id="tiers"
      style={{ borderTop: "1px solid var(--border)", background: "var(--bg2)" }}
    >
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h2>{t("title")}</h2>
          <p className="lede">{t("lede")}</p>
        </div>
        <div className="tiers rv">
          {TIERS.map(({ key, benefits }) => (
            <div className="tier" key={key}>
              <span className="tier-cadence">{t(`tier${key}Cadence`)}</span>
              <h3>{t(`tier${key}Title`)}</h3>
              <p>{t(`tier${key}Body`)}</p>
              <div className="tier-gets">{t("partnerGets")}</div>
              <ul>
                {Array.from({ length: benefits }, (_, i) => (
                  <li key={i}>{t(`tier${key}Benefit${i + 1}`)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="line-note rv">{t("streamsNote")}</p>
      </div>
    </section>
  );
}

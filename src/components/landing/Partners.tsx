import { getTranslations } from "next-intl/server";

const PARTNERS = [
  { name: "IMPACT.T" },
  { name: "HyperApp" },
  { name: "BeeLab" },
  { name: "U-BSS" },
];

export default async function Partners() {
  const t = await getTranslations("Partners");
  const partners = PARTNERS.map((partner, i) => ({
    ...partner,
    kind: t(`partner${i + 1}Kind`),
    desc: t(`partner${i + 1}Desc`),
  }));
  return (
    <section className="partners-sect" id="partners">
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h2>{t("title")}</h2>
        </div>
        <div className="partners rv">
          {partners.map((p) => (
            <div className="partner" key={p.name}>
              <div className="pn">{p.name}</div>
              <div className="pk">{p.kind}</div>
              <div className="pd">{p.desc}</div>
            </div>
          ))}
        </div>
        <p className="line-note rv">{t("disclaimer")}</p>
        <div className="cta-row rv">
          <a className="btn btn-ghost" href="mailto:binali.rustamov@aiqadam.org">
            {t("cta")}
          </a>
        </div>
      </div>
    </section>
  );
}

import { getTranslations } from "next-intl/server";

const METRICS = [
  { n: "300" },
  { n: "100+" },
  { n: "+78" },
  { n: "80+" },
  { n: "2" },
];

export default async function Metrics() {
  const t = await getTranslations("Metrics");
  const metrics = METRICS.map((metric, i) => ({
    ...metric,
    l: t(`metric${i + 1}Label`),
    s: t(`metric${i + 1}Source`),
  }));
  return (
    <section className="metrics" id="proof">
      <div className="wrap">
        <div className="metrics-grid rv">
          {metrics.map((m) => (
            <div className="metric" key={m.l}>
              <div className="n">{m.n}</div>
              <div className="l">{m.l}</div>
              <div className="s">{m.s}</div>
            </div>
          ))}
        </div>
        <p className="source-note rv">{t("sourceNote")}</p>
      </div>
    </section>
  );
}

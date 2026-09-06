import Image from "next/image";
import { getTranslations } from "next-intl/server";

const TEAM = [
  { img: "/images/team-rustamov.jpg" },
  { img: "/images/team-kambetbaeva.jpg" },
  { img: "/images/team-tytenko.jpg" },
  { img: "/images/team-vashurina.jpg" },
  { img: "/images/team-drukker.jpg" },
];

export default async function Team() {
  const t = await getTranslations("Team");
  const team = TEAM.map((member, i) => ({
    ...member,
    name: t(`team${i + 1}Name`),
    role: t(`team${i + 1}Role`),
    desc: t(`team${i + 1}Desc`),
  }));
  return (
    <section id="team">
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h2>{t("title")}</h2>
          <p className="lede">{t("lede")}</p>
        </div>
        <div className="team rv">
          {team.map((p) => (
            <article className="person" key={p.name}>
              <div className="ph">
                <Image src={p.img} alt="" width={320} height={505} />
              </div>
              <div className="pb">
                <div className="nm">{p.name}</div>
                <div className="rl">{p.role}</div>
                <div className="db">{p.desc}</div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

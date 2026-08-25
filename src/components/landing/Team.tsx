import Image from "next/image";

const TEAM = [
  {
    img: "/images/team-rustamov.jpg",
    name: "Бинали Рустамов",
    role: "Founder Global",
    desc: "CTO в BEELAB (Beepul, VEON). 12 лет в инженерии, 6+ как CTO.",
  },
  {
    img: "/images/team-kambetbaeva.jpg",
    name: "Айгерим Камбетбаева",
    role: "Country Lead — KZ",
    desc: "Senior ML Engineer в Verigram, Head of Speech Recognition в CyberNet AI.",
  },
  {
    img: "/images/team-tytenko.jpg",
    name: "Владимир Тытенко",
    role: "Co-founder",
    desc: "Head of Software Development в ABiTech. SAP Banking, Temenos T24.",
  },
  {
    img: "/images/team-vashurina.jpg",
    name: "Екатерина Вашурина",
    role: "Board",
    desc: "Ipoteka Bank (OTP Group). Запускала EPAM Uzbekistan с нуля, основатель Agile Uzbekistan.",
  },
  {
    img: "/images/team-drukker.jpg",
    name: "Виктор Друккер",
    role: "Board · События",
    desc: "Kanban / Agile-практик и коуч, Senior PM в Ipoteka Bank.",
  },
];

export default function Team() {
  return (
    <section id="team">
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">Команда</p>
          <h2>Практики, а не комьюнити-менеджеры.</h2>
          <p className="lede">
            Бренд принадлежит сообществу, а не основателю. Решения принимает
            Global Board: согласие вместо голосования, вето у страновых
            лидов на локальные вопросы.
          </p>
        </div>
        <div className="team rv">
          {TEAM.map((p) => (
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

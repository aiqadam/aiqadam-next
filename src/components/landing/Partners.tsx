const PARTNERS = [
  {
    name: "IMPACT.T",
    kind: "площадка · UZ",
    desc: "Ташкентский тех-хаб: офисы, коворкинг, залы для событий.",
  },
  {
    name: "HyperApp",
    kind: "инфраструктура · UZ",
    desc: "Облачный провайдер Узбекистана, SLA 99.999%. Стартап года 2025.",
  },
  {
    name: "BeeLab",
    kind: "пицца и мерч · UZ",
    desc: "Финтех за продуктом Beepul.",
  },
  {
    name: "U-BSS",
    kind: "трансляция · UZ",
    desc: "Узбекская речевая AI для банков.",
  },
];

export default function Partners() {
  return (
    <section className="partners-sect" id="partners">
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">Партнёры</p>
          <h2>Партнёры вкладываются в сообщество, а не покупают аудиторию.</h2>
        </div>
        <div className="partners rv">
          {PARTNERS.map((p) => (
            <div className="partner" key={p.name}>
              <div className="pn">{p.name}</div>
              <div className="pk">{p.kind}</div>
              <div className="pd">{p.desc}</div>
            </div>
          ))}
        </div>
        <p className="line-note rv">
          Мы не продаём доступ к аудитории, не торгуем данными участников и
          не ставим продающие доклады под видом экспертных. Что именно можно
          и чего нельзя — в партнёрском деке.
        </p>
        <div className="cta-row rv">
          <a className="btn btn-ghost" href="mailto:binali.rustamov@aiqadam.org">
            Обсудить партнёрство
          </a>
        </div>
      </div>
    </section>
  );
}

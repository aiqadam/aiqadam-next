import Image from "next/image";

export default function Hero() {
  return (
    <section className="hero" id="top">
      <div className="hero-media">
        <Image src="/images/hero.jpg" alt="" fill priority sizes="100vw" />
      </div>
      <div className="hero-inner">
        <div className="wrap">
          <p className="eyebrow rv">AI Qadam · UZ · KZ · KG · TJ</p>
          <h1 className="rv">
            Инженеры, которые строят AI в Центральной Азии — <em>вместе.</em>
          </h1>
          <p className="sub rv">
            Не конференция и не курс. Федерация локальных сообществ под одним
            брендом: практики рассказывают, что они делали сами, а не что
            прочитали в отчёте.
          </p>
          <div className="cta-row rv">
            <a className="btn btn-primary" href="#events">
              Ближайшее событие
            </a>
            <a className="btn btn-ghost" href="https://t.me/ai_qadam_community">
              Вступить в чат Узбекистана
            </a>
          </div>
          <div className="chapters-pills rv">
            <span className="pill active">
              <i className="dot" />
              UZBEKISTAN
            </span>
            <span className="pill active">
              <i className="dot" />
              KAZAKHSTAN
            </span>
            <span className="pill">
              <i className="dot" />
              TAJIKISTAN — СКОРО
            </span>
            <span className="pill">
              <i className="dot" />
              KYRGYZSTAN — СКОРО
            </span>
          </div>
        </div>
      </div>
      <div className="nextev">
        <div className="nextev-in">
          <span className="live">
            <i />
            Ближайшее
          </span>
          <span className="when">26 августа · 20:00</span>
          <span className="what">
            <b>Fail Stories #1</b> — честные истории провалов в AI и продукте
            · Bridge, Tashkent City
          </span>
          <a className="go" href="#events">
            По приглашениям · написать организатору →
          </a>
        </div>
      </div>
    </section>
  );
}

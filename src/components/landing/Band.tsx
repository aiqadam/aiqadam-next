export default function Band() {
  return (
    <section className="band">
      <div className="wrap">
        <h2 className="rv">Сделаем Qadam в сторону доверия.</h2>
        <p
          className="lede rv"
          style={{ marginLeft: "auto", marginRight: "auto", textAlign: "center" }}
        >
          Следующее событие — 26 августа. Следующий митап — в сентябре, CFP
          открыт.
        </p>
        <div className="cta-row rv">
          <a className="btn btn-primary" href="https://t.me/ai_qadam_community">
            Вступить в сообщество
          </a>
          <a className="btn btn-ghost" href="mailto:binali.rustamov@aiqadam.org">
            Написать нам
          </a>
        </div>
      </div>
    </section>
  );
}

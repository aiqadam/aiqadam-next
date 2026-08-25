export default function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="f-grid">
          <div className="f-col">
            <a className="brand" href="#top" style={{ marginBottom: 14 }}>
              <img src="https://brand.aiqadam.org/brand/logo-mark.svg" alt="" />
              AI Qadam
            </a>
            <p style={{ margin: 0, maxWidth: "34ch" }}>
              Некоммерческое сообщество инженеров Центральной Азии. Бренд
              принадлежит сообществу.
            </p>
          </div>
          <div className="f-col">
            <h4>Сообщество</h4>
            <a href="https://t.me/ai_qadam_community">Чат · Узбекистан</a>
            <a href="https://t.me/ai_qadam_kazakhstan">Чат · Казахстан</a>
            <a href="https://t.me/aiqadam_build">Чат · контрибьюторы</a>
          </div>
          <div className="f-col">
            <h4>Экосистема</h4>
            <a href="https://build.aiqadam.org">build.aiqadam.org</a>
            <a href="https://flow.aiqadam.org">flow.aiqadam.org</a>
            <a href="https://brand.aiqadam.org">brand.aiqadam.org</a>
            <a href="https://github.com/aiqadam">github.com/aiqadam</a>
          </div>
          <div className="f-col">
            <h4>Контакты</h4>
            <a href="mailto:binali.rustamov@aiqadam.org">
              binali.rustamov@aiqadam.org
            </a>
            <a href="https://t.me/RETURN_VOID_0">Telegram · @RETURN_VOID_0</a>
            <a href="tel:+77085272322">+7 708 527 2322</a>
          </div>
        </div>
        <div className="f-bottom">
          <span>#AIQadam</span>
          <span>КОД · MIT</span>
          <span>КОНТЕНТ · CC BY 4.0</span>
          <span>БРЕНД · AI QADAM BUP</span>
          <span style={{ marginLeft: "auto", color: "var(--border-hi)" }}>
            ПРОТОТИП ГЛАВНОЙ · v0
          </span>
        </div>
      </div>
    </footer>
  );
}

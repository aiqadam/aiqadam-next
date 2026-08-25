export default function Doors() {
  return (
    <section
      id="join"
      style={{ borderTop: "1px solid var(--border)", background: "var(--bg2)" }}
    >
      <div className="wrap">
        <div className="sect-head rv">
          <p className="eyebrow">Как участвовать</p>
          <h2>Три двери. Все открыты.</h2>
          <p className="lede">
            После первого митапа 86% участников выбрали активную роль, а не
            «просто прийти». Дальше — вопрос того, сколько времени вы готовы
            вложить.
          </p>
        </div>
        <div className="doors rv">
          <div className="door">
            <div className="dots">
              <i />
              <i />
              <i />
            </div>
            <h3>Прийти</h3>
            <p>
              Регистрация на ближайшее событие и чат страны. Бесплатно, без
              отбора, без «оставьте заявку».
            </p>
            <a href="https://t.me/ai_qadam_community">Чат Узбекистана →</a>
            <br />
            <a href="https://t.me/ai_qadam_kazakhstan">Чат Казахстана →</a>
            <span className="tag">~1 вечер в два месяца</span>
          </div>
          <div className="door">
            <div className="dots">
              <i />
              <i />
              <i />
            </div>
            <h3>Выступить</h3>
            <p>
              CFP на митап #3 в сентябре открыт. Нужен ваш собственный кейс —
              что делали, что сломалось, что получилось.
            </p>
            <a href="https://t.me/RETURN_VOID_0">Подать доклад →</a>
            <span className="tag">~2 недели на подготовку</span>
          </div>
          <div className="door">
            <div className="dots">
              <i />
              <i />
              <i />
            </div>
            <h3>Строить</h3>
            <p>
              Открытая инфраструктура региона: Qadam Flow, дизайн-система,
              портал. Contributor → committer → maintainer, по вкладу, а не
              по должности.
            </p>
            <a href="https://build.aiqadam.org">Проекты Build →</a>
            <br />
            <a href="https://t.me/aiqadam_build">Чат контрибьюторов →</a>
            <span className="tag">регулярно</span>
          </div>
        </div>
      </div>
    </section>
  );
}

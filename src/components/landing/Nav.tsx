export default function Nav() {
  return (
    <header className="nav">
      <div className="nav-in">
        <a className="brand" href="#top">
          <img src="https://brand.aiqadam.org/brand/logo-mark.svg" alt="" />
          AI Qadam
        </a>
        <nav className="nav-links">
          <a href="#events">События</a>
          <a href="#map">Чаптеры</a>
          <a href="#streams">Направления</a>
          <a href="#join">Участвовать</a>
          <a href="#team">Команда</a>
        </nav>
        <div className="lang" title="Прототип: переключатель языка">
          <span className="on">RU</span>
          <span>UZ</span>
          <span>EN</span>
        </div>
      </div>
    </header>
  );
}

import LocaleSwitcher from "./LocaleSwitcher";

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
        <LocaleSwitcher />
      </div>
    </header>
  );
}

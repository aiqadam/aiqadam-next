import { getTranslations } from "next-intl/server";
import LocaleSwitcher from "./LocaleSwitcher";

export default async function Nav() {
  const t = await getTranslations("Nav");
  return (
    <header className="nav">
      <div className="nav-in">
        <a className="brand" href="#top">
          <img src="https://brand.aiqadam.org/brand/logo-mark.svg" alt="" />
          AI Qadam
        </a>
        <nav className="nav-links">
          <a href="#events">{t("events")}</a>
          <a href="#map">{t("chapters")}</a>
          <a href="#streams">{t("streams")}</a>
          <a href="#join">{t("join")}</a>
          <a href="#team">{t("team")}</a>
        </nav>
        <LocaleSwitcher />
      </div>
    </header>
  );
}

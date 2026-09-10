import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import LocaleSwitcher from "./LocaleSwitcher";

export default async function PartnerNav() {
  const t = await getTranslations("PartnerNav");
  return (
    <header className="nav">
      <div className="nav-in">
        <Link className="brand" href="/">
          <img src="https://brand.aiqadam.org/brand/logo-mark.svg" alt="" />
          AI Qadam
        </Link>
        <nav className="nav-links">
          <a href="#why">{t("why")}</a>
          <a href="#tiers">{t("tiers")}</a>
          <a href="#line">{t("line")}</a>
          <a href="#deck">{t("deck")}</a>
        </nav>
        <Link className="nav-back" href="/">
          {t("backToSite")}
        </Link>
        <LocaleSwitcher />
      </div>
    </header>
  );
}

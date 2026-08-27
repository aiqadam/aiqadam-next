"use client";

import { useLocale } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

export default function LocaleSwitcher() {
  const activeLocale = useLocale();
  const pathname = usePathname();

  return (
    <div className="lang">
      {routing.locales.map((locale) => (
        <Link
          key={locale}
          href={pathname}
          locale={locale}
          className={locale === activeLocale ? "on" : undefined}
        >
          {locale.toUpperCase()}
        </Link>
      ))}
    </div>
  );
}

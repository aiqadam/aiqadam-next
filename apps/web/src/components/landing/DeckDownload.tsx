import { getTranslations } from "next-intl/server";

export default async function DeckDownload() {
  const t = await getTranslations("DeckDownload");
  return (
    <section
      id="deck"
      style={{ borderTop: "1px solid var(--border)", background: "var(--bg2)" }}
    >
      <div className="wrap">
        <div className="deck-card rv">
          <div className="deck-body">
            <p className="eyebrow">{t("eyebrow")}</p>
            <div className="deck-title">{t("title")}</div>
            <p>{t("body")}</p>
          </div>
          <a
            className="btn btn-ghost"
            href="/decks/ai-qadam-partnership-deck-ru.pdf"
            download
          >
            {t("cta")}
          </a>
        </div>
        <p className="source-note rv">{t("note")}</p>
      </div>
    </section>
  );
}

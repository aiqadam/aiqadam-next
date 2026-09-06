import type { Catalog } from "./types.js";
import { ru } from "./ru.js";
import { en } from "./en.js";

export type BotLang = "ru" | "en";

export const catalogs: Record<BotLang, Catalog> = { ru, en };

/** One-line lookup into `catalogs` (REQ-013 §1.3). */
export function getCatalog(lang: BotLang): Catalog {
  return catalogs[lang];
}

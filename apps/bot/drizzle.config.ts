import { defineConfig } from "drizzle-kit";

// Points drizzle-kit at this package's schema and its committed migrations
// directory (decisions/0005: migrations are generated, plain .sql, reviewed as
// SQL). DATABASE_URL is only read here, at generate/migrate time — it is never
// hardcoded (matches src/config.ts's "no literal defaults" rule for REQ-012).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});

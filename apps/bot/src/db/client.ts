import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

// Pooled Postgres client (REQ-012 §2). Receives the already-validated
// databaseUrl as a parameter — this module does no env reading itself, so
// config.ts stays the single place environment variables are read.
//
// max: 5 — single-digit pool sized for PRD 1's stated load (~1,000 users,
// ~10 events/year, peak throughput 0.06 requests/second, DB < 50MB, and
// PRD 1's own conclusion "one Postgres and one bot process are sufficient —
// do not add infrastructure"). At 0.06 rps peak the bot handles roughly one
// request every 17 seconds at its busiest stated moment; grammY's long
// polling does not run truly parallel DB calls per update the way a
// multi-worker HTTP server would, so a pool of 5 gives headroom for a burst
// (e.g. several admins clicking buttons around event-open time) without
// approaching Postgres's own default max_connections (100).
//
// connectionTimeoutMillis: 5000 — fails fast rather than hanging
// indefinitely if Postgres is unreachable, so a bad DATABASE_URL surfaces as
// a prompt failure, not a silent hang (matters for AC 2's "exits non-zero").
//
// min / idleTimeoutMillis: left at pg.Pool's own defaults — nothing in PRD 1
// asks for warm-pool pre-allocation at this load.
//
// ssl: left unset (open question 3, REQ-012.md §7) — no requirement or
// decision record states the target Postgres requires TLS; DATABASE_URL's
// own `?sslmode=` query parameter is the configuration-free alternative if
// that turns out to be needed.

export interface DbClient {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
}

export function createDbClient(databaseUrl: string): DbClient {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5000,
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

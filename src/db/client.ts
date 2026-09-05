import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
  );
}

export const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });

/**
 * Declared via the generic type, not `typeof db`. `typeof db` would bake in
 * `$client: Pool`, which is incompatible with the `$client: PoolClient`
 * instance src/db/testing.ts binds inside a transaction for test
 * isolation — even though both support exactly the same query-builder
 * methods every service actually calls. Service function signatures should
 * depend on that shared surface, not on which concrete client produced it.
 */
export type Database = NodePgDatabase<typeof schema>;

/**
 * The type Drizzle passes into `db.transaction(async (tx) => ...)`.
 * Derived from Database's own `transaction` method signature rather than
 * importing drizzle-orm's internal generic transaction type directly, so
 * it can't drift out of sync with whatever `db` actually is.
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Accepted by any service function that might be called either at the top
 * level or from inside an existing transaction (e.g. src/services/
 * approvals.ts, called both directly and from within
 * beehiiv/send-issue.ts's approveIssue transaction).
 */
export type DbClient = Database | Transaction;

/**
 * Test-only DB helpers. Not imported by any production code path.
 *
 * Flywheel's DB-backed services (approvals, subscriber sync, ...) are
 * tested against a real Postgres rather than a mock, because the thing
 * worth verifying is usually the SQL itself (a WHERE clause, a unique
 * constraint, a CHECK). `withRollback` wraps each test in a transaction
 * that always rolls back, so tests never leave rows behind — including on
 * failure — without needing a throwaway database per run.
 *
 * If DATABASE_URL isn't reachable (no local Postgres), `isDatabaseAvailable`
 * lets test files skip gracefully instead of failing the whole suite — the
 * same posture the build spec takes toward Meta/Beehiiv sandbox tests.
 *
 * Why this uses db.transaction(), not a raw BEGIN/ROLLBACK on a borrowed
 * client: several services (e.g. approveIssue in
 * src/services/beehiiv/send-issue.ts) open their own transaction via
 * db.transaction() internally. Drizzle only recognizes a transaction as
 * "nested" (and uses a SAVEPOINT) when it's called on a `tx` object that IS
 * itself a transaction — it has no way to detect a transaction started by
 * raw SQL on the same connection. A test harness that wrapped tests in raw
 * BEGIN/ROLLBACK would make any db.transaction() call inside the code under
 * test issue its own COMMIT, silently committing the "rolled back" test
 * data. Driving the outer transaction through db.transaction() itself (and
 * forcing a rollback by always throwing a sentinel at the end) makes any
 * inner db.transaction() call a genuine nested SAVEPOINT instead.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as schema from "./schema";
import type { Transaction } from "./client";

let pool: Pool | undefined;

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }
  if (!pool) {
    pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000 });
  }
  return pool;
}

let testDb: ReturnType<typeof drizzle<typeof schema>> | undefined;

function getTestDb() {
  if (!testDb) {
    testDb = drizzle(getPool(), { schema });
  }
  return testDb;
}

export async function isDatabaseAvailable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  let client: PoolClient | undefined;
  try {
    client = await getPool().connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    client?.release();
  }
}

export type TestDatabase = Transaction;

class RollbackSignal {
  constructor(public readonly result: unknown) {}
}

/**
 * Runs `fn` inside a transaction that is always rolled back afterward,
 * whether `fn` throws or not — so tests are isolated from each other and
 * from whatever else is in the database. See the file header for why this
 * is built on db.transaction() rather than a raw BEGIN/ROLLBACK.
 */
export async function withRollback<T>(
  fn: (db: TestDatabase) => Promise<T>,
): Promise<T> {
  try {
    await getTestDb().transaction(async (tx) => {
      const result = await fn(tx);
      // Force a rollback unconditionally by throwing — caught below and
      // unwrapped back into a normal return value. If `fn` itself throws,
      // that error propagates through unchanged (it isn't a RollbackSignal).
      throw new RollbackSignal(result);
    });
    throw new Error(
      "withRollback: transaction completed without rolling back — this should be unreachable",
    );
  } catch (err) {
    if (err instanceof RollbackSignal) {
      return err.result as T;
    }
    throw err;
  }
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

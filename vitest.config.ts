import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

/**
 * Tests get their own DATABASE_URL from .env.test — deliberately never
 * `.env`. Sharing a database between the test suite and real app usage is
 * exactly what caused a real incident during development: a one-off live
 * sourcing run left real persisted sources + a real ledger row sitting in
 * `flywheel`, and the next `npm test` run then failed because DB-backed
 * tests (which assume an empty table before their own transaction starts)
 * saw that real data. See .env.test.example for the DATABASE_URL this
 * expects (a separate `flywheel_test` database, same Postgres instance —
 * `CREATE DATABASE flywheel_test OWNER flywheel;`, then `db:migrate`
 * against it once).
 */
loadEnv({ path: ".env.test" });

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

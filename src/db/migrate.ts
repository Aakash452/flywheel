/**
 * Runs pending migrations against DATABASE_URL.
 *
 * Bootstraps the `vector` extension before handing off to Drizzle's
 * migrator. That has to happen outside the migrations/ folder: the very
 * first migration creates `creatives.embedding vector(1024)`, so the
 * extension must exist before migration 0000 runs, and drizzle-kit's
 * journal ordering isn't a place to inject a pre-step ahead of an
 * already-generated file.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }

  const pool = new Pool({ connectionString });

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: "./drizzle" });

    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

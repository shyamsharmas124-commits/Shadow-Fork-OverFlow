import pg from "pg";
import { migrate } from "../src/migrate.js";

/**
 * Uses DATABASE_URL when set (CI / local Postgres). Locally with Docker you can swap this for
 * Testcontainers' PostgreSqlContainer; the engine only needs a connection string.
 */
export async function makePool(): Promise<pg.Pool> {
  const connectionString =
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/durable";
  const pool = new pg.Pool({ connectionString });
  await migrate(pool);
  return pool;
}

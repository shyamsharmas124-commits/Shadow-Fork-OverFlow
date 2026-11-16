import { migrate } from "@durable/engine";
import pg from "pg";

export async function makePool(): Promise<pg.Pool> {
  const connectionString =
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/durable";
  const pool = new pg.Pool({ connectionString });
  await migrate(pool);
  return pool;
}

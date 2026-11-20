import { migrate } from "@durable/engine";
import pg from "pg";

export async function makePool(max?: number): Promise<pg.Pool> {
  const connectionString =
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/durable";
  const pool = new pg.Pool({ connectionString, max: max ?? 10 });
  await migrate(pool);
  return pool;
}

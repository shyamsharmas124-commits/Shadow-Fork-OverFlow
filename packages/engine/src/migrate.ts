import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(987654321)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const f of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const { rows } = await client.query<{ name: string }>(
        `SELECT name FROM _migrations WHERE name = $1`,
        [f],
      );
      if (rows.length === 0) {
        await client.query(readFileSync(join(dir, f), "utf8"));
        await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [f]);
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(987654321)");
    } catch {}
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(pool);
  await pool.end();
  console.log("migrated");
}

import pg from "../packages/engine/node_modules/pg/lib/index.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/durable",
});

const res = await pool.query("SELECT count(*) FROM tasks WHERE status = 'pending'");
console.log("Pending tasks in DB:", res.rows[0].count);

await pool.end();

import pg from "../packages/engine/node_modules/pg/lib/index.js";

const { Client } = pg;

async function getSchema(dbName) {
  const client = new Client({
    connectionString: `postgres://postgres:postgres@localhost:5432/${dbName}`,
  });
  await client.connect();
  try {
    const cols = await client.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name;
    `);
    const constraints = await client.query(`
      SELECT table_name, constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
      ORDER BY table_name, constraint_name;
    `);
    return { columns: cols.rows, constraints: constraints.rows };
  } finally {
    await client.end();
  }
}

async function main() {
  const [db1 = "durable_schema_a", db2 = "durable_schema_b"] = process.argv.slice(2);
  const s1 = await getSchema(db1);
  const s2 = await getSchema(db2);

  console.log(`Comparing ${db1} vs ${db2}...`);

  // Compare columns regardless of ordinal position
  const colMap1 = new Map(s1.columns.map((c) => [`${c.table_name}.${c.column_name}`, c]));
  const colMap2 = new Map(s2.columns.map((c) => [`${c.table_name}.${c.column_name}`, c]));

  let diffFound = false;

  for (const [key, c1] of colMap1.entries()) {
    const c2 = colMap2.get(key);
    if (!c2) {
      console.log(`[-] Missing in ${db2}: ${key}`);
      diffFound = true;
    } else {
      if (
        c1.data_type !== c2.data_type ||
        c1.is_nullable !== c2.is_nullable ||
        c1.column_default !== c2.column_default
      ) {
        console.log(`[~] Column diff for ${key}:`);
        console.log(`    ${db1}: data_type=${c1.data_type}, nullable=${c1.is_nullable}, default=${c1.column_default}`);
        console.log(`    ${db2}: data_type=${c2.data_type}, nullable=${c2.is_nullable}, default=${c2.column_default}`);
        diffFound = true;
      }
      if (c1.ordinal_position !== c2.ordinal_position) {
        console.log(`[i] Ordinal position diff for ${key}: ${db1}=${c1.ordinal_position}, ${db2}=${c2.ordinal_position}`);
      }
    }
  }

  for (const key of colMap2.keys()) {
    if (!colMap1.has(key)) {
      console.log(`[+] Extra in ${db2}: ${key}`);
      diffFound = true;
    }
  }

  if (!diffFound) {
    console.log("Schema definitions, data types, nullabilities, and defaults are 100% IDENTICAL.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

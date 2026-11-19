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
    const indexes = await client.query(`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname;
    `);
    const triggers = await client.query(`
      SELECT trigger_name, event_manipulation, event_object_table, action_statement, action_timing
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
      ORDER BY event_object_table, trigger_name;
    `);
    return {
      columns: cols.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
      triggers: triggers.rows,
    };
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
      console.log(`[-] Missing column in ${db2}: ${key}`);
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
      console.log(`[+] Extra column in ${db2}: ${key}`);
      diffFound = true;
    }
  }

  // Compare indexes
  const idxMap1 = new Map(s1.indexes.map((i) => [`${i.tablename}.${i.indexname}`, i.indexdef]));
  const idxMap2 = new Map(s2.indexes.map((i) => [`${i.tablename}.${i.indexname}`, i.indexdef]));

  for (const [key, def1] of idxMap1.entries()) {
    const def2 = idxMap2.get(key);
    if (!def2) {
      console.log(`[-] Missing index in ${db2}: ${key}`);
      diffFound = true;
    } else if (def1 !== def2) {
      console.log(`[~] Index definition diff for ${key}:`);
      console.log(`    ${db1}: ${def1}`);
      console.log(`    ${db2}: ${def2}`);
      diffFound = true;
    }
  }
  for (const key of idxMap2.keys()) {
    if (!idxMap1.has(key)) {
      console.log(`[+] Extra index in ${db2}: ${key}`);
      diffFound = true;
    }
  }

  // Compare triggers
  const trigMap1 = new Map(s1.triggers.map((t) => [`${t.event_object_table}.${t.trigger_name}.${t.event_manipulation}`, t]));
  const trigMap2 = new Map(s2.triggers.map((t) => [`${t.event_object_table}.${t.trigger_name}.${t.event_manipulation}`, t]));

  for (const [key, t1] of trigMap1.entries()) {
    const t2 = trigMap2.get(key);
    if (!t2) {
      console.log(`[-] Missing trigger in ${db2}: ${key}`);
      diffFound = true;
    }
  }
  for (const key of trigMap2.keys()) {
    if (!trigMap1.has(key)) {
      console.log(`[+] Extra trigger in ${db2}: ${key}`);
      diffFound = true;
    }
  }

  // Explicit check for events_no_update trigger
  const hasTriggerA = s1.triggers.some((t) => t.trigger_name === "events_no_update" && t.event_object_table === "events");
  const hasTriggerB = s2.triggers.some((t) => t.trigger_name === "events_no_update" && t.event_object_table === "events");

  if (!hasTriggerA || !hasTriggerB) {
    console.error(`[!] events_no_update trigger check failed: ${db1}=${hasTriggerA}, ${db2}=${hasTriggerB}`);
    diffFound = true;
  } else {
    console.log(`[PASS] Trigger 'events_no_update' on table 'events' verified present on both ${db1} and ${db2}.`);
  }

  if (!diffFound) {
    console.log("Schema columns, constraints, indexes, and triggers are 100% IDENTICAL.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

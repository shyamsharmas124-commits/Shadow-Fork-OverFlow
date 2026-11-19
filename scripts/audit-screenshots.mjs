import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.resolve(__dirname, "../packages/ui/screenshots");

function getFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFiles(full));
    } else if (file.endsWith(".png")) {
      results.push(full);
    }
  }
  return results;
}

const files = getFiles(screenshotsDir).sort();
console.log(`Found ${files.length} screenshots.\n`);

const hashes = new Set();
const items = [];

for (const f of files) {
  const relPath = path.relative(path.resolve(__dirname, ".."), f).replace(/\\/g, "/");
  const stat = fs.statSync(f);
  const bytes = fs.readFileSync(f);
  const size = bytes.length;
  const mtime = stat.mtime.toISOString();
  const hash = createHash("sha256").update(bytes).digest("hex");
  const duplicate = hashes.has(hash);
  hashes.add(hash);

  let spec = "packages/ui/e2e/inspector.spec.ts";
  if (relPath.includes("stage3/")) {
    spec = "packages/ui/e2e/stage3-features.spec.ts";
  }

  items.push({ relPath, size, mtime, hash, duplicate, spec });
}

console.log("| Screenshot Path | Size (Bytes) | Last Modified (mtime) | SHA-256 Checksum | Originating Playwright Spec | Unique? |");
console.log("| :--- | :---: | :---: | :--- | :--- | :---: |");
for (const item of items) {
  console.log(`| \`${item.relPath}\` | ${item.size.toLocaleString()} | ${item.mtime} | \`${item.hash}\` | \`${item.spec}\` | ${item.duplicate ? "DUPLICATE!" : "YES"} |`);
}

console.log(`\nTotal Screenshots: ${items.length}`);
console.log(`Unique Hashes: ${hashes.size} of ${items.length}`);
if (hashes.size === items.length) {
  console.log("VERIFIED: Zero duplicate screenshots found. Every screenshot has a unique SHA-256 checksum.");
} else {
  console.error("ERROR: Duplicate screenshot detected!");
  process.exit(1);
}

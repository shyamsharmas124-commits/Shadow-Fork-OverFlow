import fs from "fs";

function report(basePath, label) {
  const pkgs = ["engine", "api", "demo", "ui"];
  let total = 0;
  console.log(`=== ${label} Vitest numTotalTests ===`);
  for (const p of pkgs) {
    const jsonPath = `${basePath}/packages/${p}/.vitest/json/output.json`;
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      console.log(`  packages/${p.padEnd(8)} numTotalTests: ${data.numTotalTests}`);
      total += data.numTotalTests;
    } else {
      console.log(`  packages/${p.padEnd(8)} not found: ${jsonPath}`);
    }
  }
  console.log(`  Total: ${total}\n`);
}

report("../wt-446d3f3", "Worktree 446d3f3 (Stage 2)");
report(".", "HEAD");

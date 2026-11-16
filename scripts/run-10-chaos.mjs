import { execSync } from "node:child_process";

console.log("=========================================================================");
console.log("   RUNNING PNPM CHAOS 10 CONSECUTIVE TIMES");
console.log("=========================================================================\n");

for (let i = 1; i <= 10; i++) {
  console.log(`\n>>> PNPM CHAOS INVOCATION #${i} / 10 <<<`);
  try {
    const output = execSync("pnpm chaos", { encoding: "utf8" });
    // Print the summary report portion
    const summaryStart = output.indexOf("CHAOS TEST SUMMARY REPORT");
    if (summaryStart !== -1) {
      console.log(output.slice(summaryStart - 50));
    } else {
      console.log(output);
    }
  } catch (err) {
    console.error(`Invocation #${i} failed:`, err.stdout || err.message);
    process.exit(1);
  }
}

console.log("\n=========================================================================");
console.log("   ALL 10 CHAOS INVOCATIONS COMPLETED SUCCESSFULLY");
console.log("=========================================================================");

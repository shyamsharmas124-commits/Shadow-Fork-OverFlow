import { execSync } from "node:child_process";

console.log("Starting 10-iteration verification loop across entire test suite...");
for (let i = 1; i <= 10; i++) {
  const start = Date.now();
  process.stdout.write(`[Iteration ${i}/10] Running pnpm test... `);
  try {
    execSync("pnpm test", { stdio: "pipe" });
    const dur = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[PASS] (${dur}s)`);
  } catch (err) {
    console.log(`[FAIL]`);
    console.error(err.stdout?.toString());
    console.error(err.stderr?.toString());
    process.exit(1);
  }
}
console.log("\n=======================================================");
console.log("ALL 10 ITERATIONS PASSED CLEANLY WITH ZERO FLAKES.");
console.log("=======================================================");

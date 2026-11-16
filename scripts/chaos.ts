import http from "node:http";
import path from "node:path";
import { type ChildProcess, fork } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Engine, loadEvents, reapTasks } from "../packages/engine/src/index.js";
import { CHAOS_WORKFLOW_TYPE, chaosRecoveryWorkflow } from "./chaos-worker.js";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface IterationReport {
  iteration: number;
  workflowsTotal: number;
  workflowsCompleted: number;
  workersKilled: number;
  duplicateEffects: number;
  sequenceContiguous: boolean;
  durationMs: number;
  passed: boolean;
}

export async function runChaosIteration(
  pool: pg.Pool,
  iterationNum: number,
  options: { numWorkflows?: number; numWorkers?: number; maxDurationMs?: number } = {},
): Promise<IterationReport> {
  const numWorkflows = options.numWorkflows ?? 10;
  const numWorkers = options.numWorkers ?? 3;
  const maxDurationMs = options.maxDurationMs ?? 40000;
  const startTime = Date.now();

  // 1. Start External Mock HTTP Service
  const effectCalls = new Map<string, number>();
  const mockServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/effect") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const key = data.idempotencyKey || (req.headers["idempotency-key"] as string);
        if (key) {
          effectCalls.set(key, (effectCalls.get(key) || 0) + 1);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", count: effectCalls.get(key) || 1 }));
      } catch {
        res.writeHead(400).end();
      }
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", () => resolve()));
  const mockPort = (mockServer.address() as AddressInfo).port;
  const mockUrl = `http://127.0.0.1:${mockPort}`;

  // 2. Initialize Engine & clean tables if needed
  const engine = new Engine(pool, {
    [CHAOS_WORKFLOW_TYPE]: chaosRecoveryWorkflow,
  });

  const workerScript = path.resolve(__dirname, "chaos-worker.ts");

  // 3. Worker process management
  let workerCounter = 0;
  const workers = new Map<string, ChildProcess>();
  let workersKilled = 0;

  const spawnWorker = () => {
    workerCounter++;
    const workerId = `chaos-worker-${iterationNum}-${workerCounter}`;
    const execArgv = process.execArgv.filter(
      (arg) => !arg.startsWith("--eval") && !arg.startsWith("-e"),
    );

    const child = fork(workerScript, [workerId], {
      execArgv,
      env: {
        ...process.env,
        WORKER_ID: workerId,
        DATABASE_URL:
          process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/durable",
      },
      stdio: "ignore", // silence worker child logs for clean output
    });

    workers.set(workerId, child);

    child.on("exit", () => {
      workers.delete(workerId);
    });

    return workerId;
  };

  // Spawn initial set of workers
  for (let i = 0; i < numWorkers; i++) {
    spawnWorker();
  }

  // 4. Start 10 Workflows
  const runIds: string[] = [];
  for (let i = 0; i < numWorkflows; i++) {
    const runId = await engine.startRun(CHAOS_WORKFLOW_TYPE, {
      runId: `run-${iterationNum}-${i}`,
      mockUrl,
    });
    runIds.push(runId);
  }

  // 5. Chaos Monkey loop: randomly SIGKILL workers mid-flight and replace them
  let chaosRunning = true;
  const chaosMonkeyInterval = setInterval(async () => {
    if (!chaosRunning) return;
    const activeIds = Array.from(workers.keys());
    if (activeIds.length > 0 && workersKilled < 8) {
      const targetId = activeIds[Math.floor(Math.random() * activeIds.length)]!;
      const targetProc = workers.get(targetId);
      if (targetProc && targetProc.pid) {
        try {
          process.kill(targetProc.pid, "SIGKILL");
          workersKilled++;
          workers.delete(targetId);
          // Spawn replacement worker
          spawnWorker();
        } catch {
          // Process might have already exited
        }
      }
    }
    // Reap expired leases actively
    try {
      await reapTasks(pool, new Date(), [CHAOS_WORKFLOW_TYPE]);
    } catch {
      // Ignore
    }
  }, 250);

  // 6. Monitor workflow completion
  const checkCompletion = async () => {
    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM runs WHERE id = ANY($1::uuid[])`,
      [runIds],
    );
    const completedCount = rows.filter((r) => r.status === "completed").length;
    return completedCount;
  };

  while (Date.now() - startTime < maxDurationMs) {
    const completed = await checkCompletion();
    if (completed === numWorkflows) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  chaosRunning = false;
  clearInterval(chaosMonkeyInterval);

  // Terminate any remaining workers
  for (const [id, child] of workers) {
    try {
      if (child.pid) process.kill(child.pid, "SIGTERM");
    } catch {}
  }
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));

  // 7. Verify Invariants
  const { rows: finalRuns } = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM runs WHERE id = ANY($1::uuid[])`,
    [runIds],
  );

  const completedRunsCount = finalRuns.filter((r) => r.status === "completed").length;
  let totalDuplicateEffects = 0;
  let allSequencesContiguous = true;

  for (const runId of runIds) {
    const events = await loadEvents(pool, runId);

    // Contiguous sequence check
    for (let i = 0; i < events.length; i++) {
      if (events[i]!.seq !== i + 1) {
        allSequencesContiguous = false;
      }
    }

    // Duplicate StepCompleted check
    const stepCompletedCounts: Record<string, number> = {};
    for (const ev of events) {
      if (ev.type === "StepCompleted") {
        const stepName = (ev.payload as { name: string }).name;
        stepCompletedCounts[stepName] = (stepCompletedCounts[stepName] || 0) + 1;
        if (stepCompletedCounts[stepName]! > 1) {
          totalDuplicateEffects++;
        }
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const passed =
    completedRunsCount === numWorkflows &&
    totalDuplicateEffects === 0 &&
    allSequencesContiguous;

  return {
    iteration: iterationNum,
    workflowsTotal: numWorkflows,
    workflowsCompleted: completedRunsCount,
    workersKilled,
    duplicateEffects: totalDuplicateEffects,
    sequenceContiguous: allSequencesContiguous,
    durationMs,
    passed,
  };
}

async function main() {
  console.log("=========================================================================");
  console.log("   DURABLE WORKFLOW ENGINE - MULTI-PROCESS WORKER CHAOS TEST (5 RUNS)");
  console.log("=========================================================================\n");

  const databaseUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/durable";
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 20,
  });

  const reports: IterationReport[] = [];

  for (let iter = 1; iter <= 5; iter++) {
    process.stdout.write(`[Run ${iter}/5] Starting 10 workflows across 3 OS worker processes with random SIGKILLs... `);
    const report = await runChaosIteration(pool, iter, { numWorkflows: 10, numWorkers: 3 });
    reports.push(report);
    if (report.passed) {
      console.log(`✓ PASSED in ${(report.durationMs / 1000).toFixed(2)}s (${report.workersKilled} workers killed, 0 duplicate effects)`);
    } else {
      console.log(`✕ FAILED in ${(report.durationMs / 1000).toFixed(2)}s (${report.workflowsCompleted}/${report.workflowsTotal} completed)`);
    }
  }

  await pool.end();

  console.log("\n=====================================================================================================");
  console.log("                                    CHAOS TEST SUMMARY REPORT");
  console.log("=====================================================================================================");
  console.log("| Iteration | Workflows | Completed | Workers Killed | Duplicate Effects | Contiguous Seq | Duration | Status |");
  console.log("|-----------|-----------|-----------|----------------|-------------------|----------------|----------|--------|");
  for (const r of reports) {
    const iterStr = `Run #${r.iteration}`.padEnd(9);
    const wfStr = `${r.workflowsTotal}`.padEnd(9);
    const compStr = `${r.workflowsCompleted}`.padEnd(9);
    const killedStr = `${r.workersKilled}`.padEnd(14);
    const dupStr = `${r.duplicateEffects}`.padEnd(17);
    const seqStr = (r.sequenceContiguous ? "YES" : "NO").padEnd(14);
    const durStr = `${(r.durationMs / 1000).toFixed(2)}s`.padEnd(8);
    const statusStr = r.passed ? "PASS" : "FAIL";
    console.log(`| ${iterStr} | ${wfStr} | ${compStr} | ${killedStr} | ${dupStr} | ${seqStr} | ${durStr} | ${statusStr}   |`);
  }
  console.log("=====================================================================================================\n");

  const allPassed = reports.every((r) => r.passed);
  if (!allPassed) {
    console.error("Some chaos iterations failed!");
    process.exit(1);
  }
  console.log("All 5 chaos iterations passed with 100% completion, 0 duplicate effects, and strictly contiguous sequence numbers!");
}

// Auto-run if main
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Chaos test failed:", err);
    process.exit(1);
  });
}

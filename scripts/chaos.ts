import http from "node:http";
import path from "node:path";
import { type ChildProcess, fork } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Engine, loadEvents } from "../packages/engine/src/index.js";
import { CHAOS_WORKFLOW_TYPE, chaosRecoveryWorkflow } from "./chaos-worker.js";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Windows Signal Semantics & Kill Behavior:
 * On Windows, POSIX signals (SIGKILL, SIGTERM, SIGINT) are not natively supported by the OS.
 * As documented in Node.js official documentation for v24.x:
 * Reference: https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events
 * - In Node.js on Windows, `process.kill(pid, "SIGKILL")` terminates the target process
 *   unconditionally using the Win32 `TerminateProcess` API. The process exits abruptly with no cleanup.
 * - The supervisor process detects process termination via libuv's process handle watcher,
 *   which fires the `child.on("exit")` event on the ChildProcess instance.
 *
 * Kill Budget:
 * In each iteration, a fixed budget of 8 worker kills is executed (`workersKilled < 8`).
 * Every 250ms, the chaos monitor selects an active worker at random from the active worker pool
 * and issues `process.kill(pid, "SIGKILL")`, immediately spawning a replacement worker.
 * This fixed kill budget guarantees deterministic lease stress across the 10 concurrent workflows
 * while allowing surviving workers to finish all remaining tasks within the test timeout.
 */

export interface IterationReport {
  iteration: number;
  workflowsTotal: number;
  workflowsCompleted: number;
  workersKilled: number;
  rawRequests: number;
  uniqueKeys: number;
  duplicateAttempts: number;
  duplicateEffectsInLog: number;
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
  const maxDurationMs = options.maxDurationMs ?? 45000;
  const startTime = Date.now();

  // 1. External Mock HTTP Service in COUNT-ONLY mode (no deduplication)
  // Receives raw HTTP requests, records every arrival, and counts raw attempts per idempotency key.
  let rawRequestsCount = 0;
  const requestsPerKey = new Map<string, number>();
  const rawRequestsLog: Array<{ key: string; runId: string; step: string }> = [];

  const mockServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/effect") {
      rawRequestsCount++;
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const key = data.idempotencyKey || (req.headers["idempotency-key"] as string);
        if (key) {
          requestsPerKey.set(key, (requestsPerKey.get(key) || 0) + 1);
          rawRequestsLog.push({
            key,
            runId: data.runId || "unknown",
            step: data.step || "unknown",
          });
        }
        // Count-only mode: responds 200 OK without performing receiver deduplication
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", count: requestsPerKey.get(key) || 1 }));
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

    // Supervisor detects kill via child exit event
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

  // 5. Chaos Monkey loop: randomly SIGKILL workers mid-flight (up to fixed cap of 8 kills) and replace them
  let chaosRunning = true;
  const chaosMonkeyInterval = setInterval(async () => {
    if (!chaosRunning) return;
    const activeIds = Array.from(workers.keys());
    if (activeIds.length > 0 && workersKilled < 8) {
      // Pick random active worker
      const targetId = activeIds[Math.floor(Math.random() * activeIds.length)]!;
      const targetProc = workers.get(targetId);
      if (targetProc && targetProc.pid) {
        try {
          process.kill(targetProc.pid, "SIGKILL");
          workersKilled++;
          workers.delete(targetId);
          // Spawn replacement worker immediately
          spawnWorker();
        } catch {
          // Process might have already exited
        }
      }
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
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {}
  }
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));

  // 7. Verify Invariants
  const { rows: finalRuns } = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM runs WHERE id = ANY($1::uuid[])`,
    [runIds],
  );

  const completedRunsCount = finalRuns.filter((r) => r.status === "completed").length;
  let totalDuplicateEffectsInLog = 0;
  let allSequencesContiguous = true;

  for (const runId of runIds) {
    const events = await loadEvents(pool, runId);

    // Contiguous sequence check
    for (let i = 0; i < events.length; i++) {
      if (events[i]!.seq !== i + 1) {
        allSequencesContiguous = false;
      }
    }

    // Duplicate StepCompleted check in database event log
    const stepCompletedCounts: Record<string, number> = {};
    for (const ev of events) {
      if (ev.type === "StepCompleted") {
        const stepName = (ev.payload as { name: string }).name;
        stepCompletedCounts[stepName] = (stepCompletedCounts[stepName] || 0) + 1;
        if (stepCompletedCounts[stepName]! > 1) {
          totalDuplicateEffectsInLog++;
        }
      }
    }
  }

  // Check raw receiver requests vs unique idempotency keys
  const uniqueKeysCount = requestsPerKey.size;
  const duplicateAttemptsCount = rawRequestsCount - uniqueKeysCount;

  // Verify that any duplicate attempt carried the exact same key as the original attempt
  for (const [key, count] of requestsPerKey.entries()) {
    if (count > 1) {
      const matching = rawRequestsLog.filter((r) => r.key === key);
      const firstRunId = matching[0]?.runId;
      const firstStep = matching[0]?.step;
      for (const m of matching) {
        if (m.runId !== firstRunId || m.step !== firstStep) {
          throw new Error(`Idempotency key collision across different steps: key=${key}`);
        }
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const passed =
    completedRunsCount === numWorkflows &&
    totalDuplicateEffectsInLog === 0 &&
    allSequencesContiguous;

  return {
    iteration: iterationNum,
    workflowsTotal: numWorkflows,
    workflowsCompleted: completedRunsCount,
    workersKilled,
    rawRequests: rawRequestsCount,
    uniqueKeys: uniqueKeysCount,
    duplicateAttempts: duplicateAttemptsCount,
    duplicateEffectsInLog: totalDuplicateEffectsInLog,
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
      console.log(`✓ PASSED in ${(report.durationMs / 1000).toFixed(2)}s`);
      console.log(`        Kill budget: ${report.workersKilled} workers killed via SIGKILL (Win32 TerminateProcess)`);
      console.log(`        Receiver raw requests: ${report.rawRequests} | Unique keys: ${report.uniqueKeys} | Duplicate network attempts: ${report.duplicateAttempts}`);
      console.log(`        Event log: 0 duplicate StepCompleted events | Contiguous seq: ${report.sequenceContiguous ? "YES" : "NO"}`);
    } else {
      console.log(`✕ FAILED in ${(report.durationMs / 1000).toFixed(2)}s (${report.workflowsCompleted}/${report.workflowsTotal} completed)`);
    }
  }

  await pool.end();

  console.log("\n===================================================================================================================================");
  console.log("                                               CHAOS TEST SUMMARY REPORT");
  console.log("===================================================================================================================================");
  console.log("| Iteration | Workflows | Completed | Workers Killed | Raw Requests | Unique Keys | Duplicate Attempts | Event Log Dups | Contiguous | Duration | Status |");
  console.log("|-----------|-----------|-----------|----------------|--------------|-------------|--------------------|----------------|------------|----------|--------|");
  for (const r of reports) {
    const iterStr = `Run #${r.iteration}`.padEnd(9);
    const wfStr = `${r.workflowsTotal}`.padEnd(9);
    const compStr = `${r.workflowsCompleted}`.padEnd(9);
    const killedStr = `${r.workersKilled}`.padEnd(14);
    const rawStr = `${r.rawRequests}`.padEnd(12);
    const uniqStr = `${r.uniqueKeys}`.padEnd(11);
    const dupAttStr = `${r.duplicateAttempts}`.padEnd(18);
    const dupLogStr = `${r.duplicateEffectsInLog}`.padEnd(14);
    const seqStr = (r.sequenceContiguous ? "YES" : "NO").padEnd(10);
    const durStr = `${(r.durationMs / 1000).toFixed(2)}s`.padEnd(8);
    const statusStr = r.passed ? "PASS" : "FAIL";
    console.log(`| ${iterStr} | ${wfStr} | ${compStr} | ${killedStr} | ${rawStr} | ${uniqStr} | ${dupAttStr} | ${dupLogStr} | ${seqStr} | ${durStr} | ${statusStr}   |`);
  }
  console.log("===================================================================================================================================\n");

  const allPassed = reports.every((r) => r.passed);
  if (!allPassed) {
    console.error("Some chaos iterations failed!");
    process.exit(1);
  }

  const totalWorkflows = reports.reduce((s, r) => s + r.workflowsTotal, 0);
  const totalCompleted = reports.reduce((s, r) => s + r.workflowsCompleted, 0);
  const totalKilled = reports.reduce((s, r) => s + r.workersKilled, 0);
  const totalRaw = reports.reduce((s, r) => s + r.rawRequests, 0);
  const totalUnique = reports.reduce((s, r) => s + r.uniqueKeys, 0);
  const totalDupAttempts = reports.reduce((s, r) => s + r.duplicateAttempts, 0);

  if (totalDupAttempts > 0) {
    console.log(
      `All ${reports.length} chaos iterations passed with 100% completion (${totalCompleted}/${totalWorkflows} workflows, ${totalKilled} workers killed via SIGKILL), ${totalDupAttempts} duplicate network attempts verified carrying identical idempotency keys (${totalRaw} raw requests, ${totalUnique} unique keys), and exactly-once event log recording (0 duplicate StepCompleted events across all runs)!`,
    );
  } else {
    console.log(
      `All ${reports.length} chaos iterations passed with 100% completion (${totalCompleted}/${totalWorkflows} workflows, ${totalKilled} workers killed via SIGKILL), 0 duplicate network attempts observed (${totalRaw} raw requests, ${totalUnique} unique keys), and exactly-once event log recording (0 duplicate StepCompleted events across all runs)!`,
    );
  }
  process.exit(0);
}

// Auto-run if main
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Chaos test failed:", err);
    process.exit(1);
  });
}


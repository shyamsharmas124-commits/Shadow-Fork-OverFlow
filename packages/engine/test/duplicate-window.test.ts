import { type ChildProcess, fork } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine, loadEvents, makeIdempotencyKey, reapTasks, Worker } from "../src/index.js";
import {
  DUPLICATE_WINDOW_WORKFLOW_TYPE,
  duplicateWindowWorkflow,
} from "./helpers/duplicate-window-worker.js";
import { makePool } from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerScript = path.resolve(__dirname, "helpers/duplicate-window-worker.ts");

describe("Deterministic Duplicate-Window Test (Real OS Processes & SIGKILL)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await makePool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("gating verification: __testHookBeforeStepCommit cannot be enabled in non-test runs", async () => {
    const origEnv = process.env.NODE_ENV;
    try {
      // Simulate production / non-test environment
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      let hookCalled = false;
      const wf = `wf_gating_${Date.now()}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx) => {
          return await ctx.step("step-gate", () => "ok", {});
        },
      });

      const worker = new Worker(engine, {
        workerId: "test-gate-worker",
        __testHookBeforeStepCommit: () => {
          hookCalled = true;
        },
      });

      const runId = await engine.startRun(wf, {});
      await worker.tick();

      // Hook must NOT have been called because NODE_ENV !== "test"
      expect(hookCalled).toBe(false);

      await pool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnv;
    }
  });

  it("kills worker with SIGKILL during post-request / pre-commit window: counting server receives exactly 2 requests with identical Idempotency-Key and DB records exactly 1 StepCompleted", async () => {
    // 1. External Counting Server (count-only mode, no receiver deduplication)
    const serverRequests: Array<{ key: string; rawBody: string }> = [];
    let resolveFirstRequest: () => void;
    const firstRequestPromise = new Promise<void>((res) => {
      resolveFirstRequest = res;
    });

    const countingServer = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/charge") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const key = req.headers["idempotency-key"] as string;
        serverRequests.push({ key, rawBody: body });

        if (serverRequests.length === 1) {
          resolveFirstRequest();
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", count: serverRequests.length }));
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => countingServer.listen(0, "127.0.0.1", () => resolve()));
    const serverPort = (countingServer.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const childrenToClean: ChildProcess[] = [];
    const spawnWorkerProcess = (workerId: string, pauseBeforeCommit: boolean): ChildProcess => {
      const child = fork(workerScript, [workerId], {
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          NODE_ENV: "test",
          DEBUG_WORKER: "true",
          WORKER_ID: workerId,
          TEST_PAUSE_BEFORE_COMMIT: pauseBeforeCommit ? "true" : "false",
          DATABASE_URL:
            process.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/durable",
        },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
      childrenToClean.push(child);
      return child;
    };

    try {
      const engine = new Engine(pool, {
        [DUPLICATE_WINDOW_WORKFLOW_TYPE]: duplicateWindowWorkflow,
      });

      // 2. Spawn Worker 1 with TEST_PAUSE_BEFORE_COMMIT enabled
      let resolvePaused: () => void;
      const pausedPromise = new Promise<void>((res) => {
        resolvePaused = res;
      });

      const worker1 = spawnWorkerProcess("worker-victim-1", true);
      worker1.on("message", (msg: { type: string }) => {
        if (msg.type === "paused_before_commit") {
          resolvePaused();
        }
      });

      // 3. Start workflow run
      const runId = await engine.startRun(DUPLICATE_WINDOW_WORKFLOW_TYPE, {
        countingServerUrl: serverUrl,
      });

      // 4. Await counting server receiving request 1 AND worker pausing in pre-commit window
      await Promise.all([firstRequestPromise, pausedPromise]);

      // Assert server has received exactly 1 request
      expect(serverRequests.length).toBe(1);

      // Assert that StepCompleted event has NOT been committed in database yet
      const eventsBeforeKill = await loadEvents(pool, runId);
      const completedBeforeKill = eventsBeforeKill.filter((e) => e.type === "StepCompleted");
      expect(completedBeforeKill.length).toBe(0);

      // 5. Kill Worker 1 unconditionally with SIGKILL (Win32 TerminateProcess)
      const worker1ExitedPromise = new Promise<void>((res) => {
        worker1.on("exit", () => res());
      });
      process.kill(worker1.pid!, "SIGKILL");
      await worker1ExitedPromise;

      // 6. Return expired running tasks back to pending
      // Force task lease expiration in DB so reaper resets it immediately
      await pool.query(
        `UPDATE tasks SET lease_expires_at = now() - interval '5 seconds' WHERE run_id = $1`,
        [runId],
      );
      const reaped = await reapTasks(pool);
      expect(reaped.length).toBeGreaterThanOrEqual(1);

      // 7. Spawn Worker 2 (clean run, no pause) to complete the workflow
      const _worker2 = spawnWorkerProcess("worker-survivor-2", false);

      // Wait until run finishes
      let completedRun = await engine.getRun(runId);
      const startPoll = Date.now();
      while (completedRun?.status === "running" && Date.now() - startPoll < 10000) {
        await new Promise((r) => setTimeout(r, 100));
        completedRun = await engine.getRun(runId);
      }

      expect(completedRun?.status).toBe("completed");

      // 8. Assertions:
      // (a) Server received exactly 2 requests (attempt 1 before kill + attempt 2 on retry)
      expect(serverRequests.length).toBe(2);

      // (b) Both requests carried the EXACT same Idempotency-Key
      const expectedIdempotencyKey = makeIdempotencyKey(runId, "charge-payment");
      expect(serverRequests[0]!.key).toBe(expectedIdempotencyKey);
      expect(serverRequests[1]!.key).toBe(expectedIdempotencyKey);
      expect(serverRequests[0]!.key).toBe(serverRequests[1]!.key);

      // (c) Database event log has strictly 1 StepCompleted event for the step
      const finalEvents = await loadEvents(pool, runId);
      const stepCompletedFinal = finalEvents.filter(
        (e) =>
          e.type === "StepCompleted" && (e.payload as { name: string }).name === "charge-payment",
      );
      expect(stepCompletedFinal.length).toBe(1);

      // Cleanup tasks
      await pool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
    } finally {
      for (const child of childrenToClean) {
        try {
          if (child.pid) process.kill(child.pid, "SIGKILL");
        } catch {}
      }
      await new Promise<void>((resolve) => countingServer.close(() => resolve()));
    }
  }, 15000);
});

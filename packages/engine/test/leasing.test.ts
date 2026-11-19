import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  claimTask,
  completeTask,
  Engine,
  FencingError,
  failTask,
  heartbeatTask,
  loadEvents,
  reapTasks,
  Worker,
  type WorkflowFn,
} from "../src/index.js";
import { makePool } from "./helpers.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = await makePool();
});

afterAll(async () => {
  await pool.end();
});

describe("Milestone 2 - Leasing primitives", () => {
  it("claimTask atomically claims pending task with SKIP LOCKED", async () => {
    const wf = `claim_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, { [wf]: async () => 1 });
    const _runId = await engine.startRun(wf, {});

    const claimed1 = await claimTask(pool, "worker-a", 1000, [wf]);
    expect(claimed1).not.toBeNull();
    expect(claimed1?.status).toBe("running");
    expect(claimed1?.lease_owner).toBe("worker-a");
    expect(claimed1?.attempt).toBeGreaterThanOrEqual(1);

    // Verify database row state reflects the lease
    const { rows } = await pool.query<{ status: string; lease_owner: string }>(
      `SELECT status, lease_owner FROM tasks WHERE id = $1`,
      [claimed1!.id],
    );
    expect(rows[0]?.status).toBe("running");
    expect(rows[0]?.lease_owner).toBe("worker-a");
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [claimed1!.id]);
  });

  it("heartbeat extends lease_expires_at", async () => {
    const wf = `hb_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, { [wf]: async () => 1 });
    const _runId = await engine.startRun(wf, {});

    const claimed = await claimTask(pool, "worker-hb", 500, [wf]);
    expect(claimed).not.toBeNull();
    const initialExpiry = new Date(claimed!.lease_expires_at!).getTime();

    // Small delay, then heartbeat with longer lease
    await new Promise((r) => setTimeout(r, 50));
    const ok = await heartbeatTask(pool, claimed!.id, "worker-hb", 2000);
    expect(ok).toBe(true);

    const { rows } = await pool.query<{ lease_expires_at: Date }>(
      `SELECT lease_expires_at FROM tasks WHERE id = $1`,
      [claimed!.id],
    );
    const updatedExpiry = new Date(rows[0]!.lease_expires_at).getTime();
    expect(updatedExpiry).toBeGreaterThan(initialExpiry);
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [claimed!.id]);
  });

  it("reaper returns expired running tasks to pending", async () => {
    const wf = `reap_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, { [wf]: async () => 1 });
    const _runId = await engine.startRun(wf, {});

    // Claim with lease (300ms)
    const claimed = await claimTask(pool, "worker-reap", 300, [wf]);
    expect(claimed).not.toBeNull();

    // Before expiry, reaper should not reap it
    const reapedEarly = await reapTasks(pool, undefined, [wf]);
    expect(reapedEarly).not.toContain(claimed!.id);

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 350));

    // After expiry, reaper returns it to pending
    const reaped = await reapTasks(pool, undefined, [wf]);
    expect(reaped).toContain(claimed!.id);

    const { rows } = await pool.query<{ status: string; lease_owner: string | null }>(
      `SELECT status, lease_owner FROM tasks WHERE id = $1`,
      [claimed!.id],
    );
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.lease_owner).toBeNull();
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [claimed!.id]);
  });

  it("fencing prevents a zombie worker from completing a reassigned task", async () => {
    const wf = `fence_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, { [wf]: async () => 1 });
    const _runId = await engine.startRun(wf, {});

    // Worker 1 claims task with 50ms lease
    const task = await claimTask(pool, "worker-1", 50, [wf]);
    expect(task).not.toBeNull();

    // Worker 1 pauses (lease expires)
    await new Promise((r) => setTimeout(r, 80));

    // Reaper returns task to pending
    await reapTasks(pool, undefined, [wf]);

    // Worker 2 claims the task
    const task2 = await claimTask(pool, "worker-2", 2000, [wf]);
    expect(task2).not.toBeNull();
    expect(task2?.id).toBe(task!.id);
    expect(task2?.lease_owner).toBe("worker-2");

    // Zombie Worker 1 wakes up and attempts to complete the task
    await expect(completeTask(pool, task!.id, "worker-1")).rejects.toBeInstanceOf(FencingError);

    // Worker 2 completes the task successfully
    await expect(completeTask(pool, task!.id, "worker-2")).resolves.toBeUndefined();

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [task!.id],
    );
    expect(rows[0]?.status).toBe("completed");
  });

  it("failTask respects fencing and rejects zombie worker", async () => {
    const wf = `fail_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, { [wf]: async () => 1 });
    const _runId = await engine.startRun(wf, {});

    const task = await claimTask(pool, "worker-fail-1", 50, [wf]);
    expect(task).not.toBeNull();

    await new Promise((r) => setTimeout(r, 80));
    await reapTasks(pool, undefined, [wf]);

    const task2 = await claimTask(pool, "worker-fail-2", 2000, [wf]);
    expect(task2).not.toBeNull();
    expect(task2?.lease_owner).toBe("worker-fail-2");

    // Zombie worker-fail-1 attempts to mark task failed
    await expect(failTask(pool, task!.id, "worker-fail-1")).rejects.toBeInstanceOf(FencingError);
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [task!.id]);
  });
});

describe("Milestone 2 - 3 Workers on real Postgres with mid-task kill", () => {
  it("executes workflow across 3 workers, kills one mid-task, and every task completes exactly once in event log", async () => {
    const stepInvocations = {
      step1: 0,
      step2: 0,
      step3: 0,
    };

    let victimKilled = false;
    let victimWorker: Worker | null = null;
    const workerMap = new Map<string, Worker>();

    const multiStepWorkflow: WorkflowFn = async (ctx, input: { base: number }) => {
      const r1 = await ctx.step(
        "step1",
        async (n: number) => {
          stepInvocations.step1++;
          return n + 10;
        },
        input.base,
      );

      const r2 = await ctx.step(
        "step2",
        async (n: number, sctx) => {
          stepInvocations.step2++;
          if (!victimKilled) {
            victimKilled = true;
            victimWorker = workerMap.get(sctx.workerId) ?? null;
            // Mid-task kill: kill the executing worker immediately while executing step2
            victimWorker?.kill();
            // Simulate process hang/death by stalling this worker until lease expires
            await new Promise((resolve) => setTimeout(resolve, 140));
          } else {
            // Surviving worker processes step2 while victim worker is waking up as a zombie
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          return { val: n * 2, workerId: sctx.workerId };
        },
        r1,
      );

      const r3 = await ctx.step(
        "step3",
        async (input: { val: number; workerId: string }) => {
          stepInvocations.step3++;
          return input.val + 5;
        },
        r2,
      );

      return { final: r3 };
    };

    const wf = `multiStep_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, { [wf]: multiStepWorkflow });

    // Fast lease (100ms) and heartbeats (25ms) for swift deterministic testing
    const worker1 = new Worker(engine, {
      workerId: "worker-1",
      leaseDurationMs: 100,
      heartbeatIntervalMs: 25,
      pollIntervalMs: 15,
    });
    const worker2 = new Worker(engine, {
      workerId: "worker-2",
      leaseDurationMs: 100,
      heartbeatIntervalMs: 25,
      pollIntervalMs: 15,
    });
    const worker3 = new Worker(engine, {
      workerId: "worker-3",
      leaseDurationMs: 100,
      heartbeatIntervalMs: 25,
      pollIntervalMs: 15,
    });

    workerMap.set("worker-1", worker1);
    workerMap.set("worker-2", worker2);
    workerMap.set("worker-3", worker3);

    // Start all 3 workers
    worker1.start();
    worker2.start();
    worker3.start();

    // Start a run
    const runId = await engine.startRun(wf, { base: 5 });

    // Background reaper interval to reap any expired tasks
    const reaperInterval = setInterval(async () => {
      await engine.reap(undefined, [wf]).catch(() => {});
    }, 30);

    // Wait until run completes
    const startTime = Date.now();
    let runCompleted = false;
    while (Date.now() - startTime < 8000) {
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM runs WHERE id = $1`,
        [runId],
      );
      if (rows[0]?.status === "completed") {
        runCompleted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }

    clearInterval(reaperInterval);
    await worker1.stop();
    await worker2.stop();
    await worker3.stop();

    expect(runCompleted).toBe(true);
    expect(victimKilled).toBe(true);
    expect(victimWorker).not.toBeNull();
    expect(victimWorker!.lastFencingError).toBeInstanceOf(FencingError);

    // Verify event log
    const events = await loadEvents(pool, runId);
    const eventTypes = events.map((e) => e.type);

    // RunStarted, StepCompleted(step1), StepCompleted(step2), StepCompleted(step3), RunCompleted
    expect(eventTypes).toEqual([
      "RunStarted",
      "StepCompleted",
      "StepCompleted",
      "StepCompleted",
      "RunCompleted",
    ]);

    // Assert strictly monotonic seq with no gaps: 1, 2, 3, 4, 5
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    // Verify step2 was completed by a surviving worker, not the killed victim worker
    const step2Event = events.find(
      (e) => e.type === "StepCompleted" && (e.payload as { name: string }).name === "step2",
    );
    expect(step2Event).toBeDefined();
    const step2Payload = step2Event!.payload as { result: { workerId: string } };
    expect(step2Payload.result.workerId).not.toBe(victimWorker!.workerId);

    // Verify every step completed exactly once in the event log
    const completedStepNames = events
      .filter((e) => e.type === "StepCompleted")
      .map((e) => (e.payload as { name: string }).name);

    expect(completedStepNames).toEqual(["step1", "step2", "step3"]);

    // Assert the final result of the workflow: (5 + 10) * 2 + 5 = 35
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.type).toBe("RunCompleted");
    expect(lastEvent?.payload).toEqual({ result: { final: 35 } });

    // Assert all tasks in tasks table are completed
    const { rows: taskRows } = await pool.query<{ step_key: string; status: string }>(
      `SELECT step_key, status FROM tasks WHERE run_id = $1 ORDER BY step_key`,
      [runId],
    );
    for (const t of taskRows) {
      expect(t.status).toBe("completed");
    }
  }, 15000);

  it("a failing reap is logged with rate-limiting and does not stop the worker", async () => {
    const wf = `reap_fail_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, { [wf]: async () => ({ ok: true }) });

    // Mock engine.reap to reject with an error
    const reapError = new Error("Simulated transient PostgreSQL connection error during reap");
    const reapSpy = vi.spyOn(engine, "reap").mockRejectedValue(reapError);

    const loggedErrors: unknown[][] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      loggedErrors.push(args);
    });

    try {
      const worker = new Worker(engine, {
        workerId: "worker-reap-fail-test",
        reapErrorThrottleMs: 5000,
      });

      // 1. First tick with no tasks: reap fails, error is logged, tick returns false, worker does NOT throw
      const didWork1 = await worker.tick();
      expect(didWork1).toBe(false);
      expect(reapSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(String(loggedErrors[0]![0])).toContain(
        "[Worker worker-reap-fail-test] Error during autonomous task reaping:",
      );

      // 2. Second tick immediately: reap fails again, but error is throttled/not spammed
      const didWork2 = await worker.tick();
      expect(didWork2).toBe(false);
      expect(reapSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1); // Throttled: not called a second time

      // 3. Worker remains fully operational and executes pending task despite failing reap
      const runId = await engine.startRun(wf, {});
      const didWork3 = await worker.tick();
      expect(didWork3).toBe(true);

      const events = await loadEvents(pool, runId);
      expect(events.some((e) => e.type === "RunCompleted")).toBe(true);
    } finally {
      reapSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});

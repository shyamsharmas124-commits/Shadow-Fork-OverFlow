import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    const engine = new Engine(pool, { dummy: async () => 1 });
    const _runId = await engine.startRun("dummy", {});

    const claimed1 = await claimTask(pool, "worker-a", 1000);
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
  });

  it("heartbeat extends lease_expires_at", async () => {
    const engine = new Engine(pool, { dummy: async () => 1 });
    const _runId = await engine.startRun("dummy", {});

    const claimed = await claimTask(pool, "worker-hb", 500);
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
  });

  it("reaper returns expired running tasks to pending", async () => {
    const engine = new Engine(pool, { dummy: async () => 1 });
    const _runId = await engine.startRun("dummy", {});

    // Claim with very short lease (50ms)
    const claimed = await claimTask(pool, "worker-reap", 50);
    expect(claimed).not.toBeNull();

    // Before expiry, reaper should not reap it
    const reapedEarly = await reapTasks(pool);
    expect(reapedEarly).not.toContain(claimed!.id);

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 80));

    // After expiry, reaper returns it to pending
    const reaped = await reapTasks(pool);
    expect(reaped).toContain(claimed!.id);

    const { rows } = await pool.query<{ status: string; lease_owner: string | null }>(
      `SELECT status, lease_owner FROM tasks WHERE id = $1`,
      [claimed!.id],
    );
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.lease_owner).toBeNull();
  });

  it("fencing prevents a zombie worker from completing a reassigned task", async () => {
    const engine = new Engine(pool, { dummy: async () => 1 });
    const _runId = await engine.startRun("dummy", {});

    // Worker 1 claims task with 50ms lease
    const task = await claimTask(pool, "worker-1", 50);
    expect(task).not.toBeNull();

    // Worker 1 pauses (lease expires)
    await new Promise((r) => setTimeout(r, 80));

    // Reaper returns task to pending
    await reapTasks(pool);

    // Worker 2 claims the task
    const task2 = await claimTask(pool, "worker-2", 2000);
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
    const engine = new Engine(pool, { dummy: async () => 1 });
    const _runId = await engine.startRun("dummy", {});

    const task = await claimTask(pool, "worker-fail-1", 50);
    expect(task).not.toBeNull();

    await new Promise((r) => setTimeout(r, 80));
    await reapTasks(pool);

    const task2 = await claimTask(pool, "worker-fail-2", 2000);
    expect(task2).not.toBeNull();
    expect(task2?.lease_owner).toBe("worker-fail-2");

    // Zombie worker-fail-1 attempts to mark task failed
    await expect(failTask(pool, task!.id, "worker-fail-1")).rejects.toBeInstanceOf(FencingError);
  });
});

describe("Milestone 2 - 3 Workers on real Postgres with mid-task kill", () => {
  it("executes workflow across 3 workers, kills one mid-task, and every task completes exactly once in event log", async () => {
    const stepInvocations = {
      step1: 0,
      step2: 0,
      step3: 0,
    };

    let worker1Killed = false;
    let worker1Ref: Worker | null = null;

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
        async (n: number) => {
          stepInvocations.step2++;
          if (!worker1Killed && worker1Ref) {
            worker1Killed = true;
            // Mid-task kill: kill worker1 immediately while executing step2
            worker1Ref.kill();
            // Simulate process hang/death by stalling this worker until lease expires
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return n * 2;
        },
        r1,
      );

      const r3 = await ctx.step(
        "step3",
        async (n: number) => {
          stepInvocations.step3++;
          return n + 5;
        },
        r2,
      );

      return { final: r3 };
    };

    const engine = new Engine(pool, { multiStep: multiStepWorkflow });

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

    worker1Ref = worker1;

    // Start all 3 workers
    worker1.start();
    worker2.start();
    worker3.start();

    // Start a run
    const runId = await engine.startRun("multiStep", { base: 5 });

    // Background reaper interval to reap any expired tasks
    const reaperInterval = setInterval(async () => {
      await engine.reap().catch(() => {});
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
    await worker2.stop();
    await worker3.stop();

    expect(runCompleted).toBe(true);
    expect(worker1Killed).toBe(true);

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
});

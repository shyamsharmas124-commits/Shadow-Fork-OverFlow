import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import { type Ctx, makeIdempotencyKey } from "../src/context.js";
import { Engine } from "../src/engine.js";
import { loadEvents } from "../src/events.js";
import { reapTasks } from "../src/leasing.js";
import { calculateFullJitterBackoff } from "../src/retry.js";
import { Worker } from "../src/worker.js";
import { makePool } from "./helpers.js";

describe("Milestone 3 - Reliability: Retries, Timeouts, and Idempotency Keys", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await makePool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("calculates exponential backoff with full jitter within bounded ceiling", () => {
    const options = {
      initialBackoffMs: 1000,
      maxBackoffMs: 8000,
      backoffMultiplier: 2,
    };

    // Ceilings:
    // attempt 1: min(8000, 1000 * 2^0) = 1000
    // attempt 2: min(8000, 1000 * 2^1) = 2000
    // attempt 3: min(8000, 1000 * 2^2) = 4000
    // attempt 4: min(8000, 1000 * 2^3) = 8000
    // attempt 5: min(8000, 1000 * 2^4) = 8000 (capped at maxBackoffMs)
    expect(calculateFullJitterBackoff(1, { ...options, randomFn: () => 1.0 })).toBe(1000);
    expect(calculateFullJitterBackoff(2, { ...options, randomFn: () => 1.0 })).toBe(2000);
    expect(calculateFullJitterBackoff(3, { ...options, randomFn: () => 1.0 })).toBe(4000);
    expect(calculateFullJitterBackoff(4, { ...options, randomFn: () => 1.0 })).toBe(8000);
    expect(calculateFullJitterBackoff(5, { ...options, randomFn: () => 1.0 })).toBe(8000);

    // Random jitter bounds
    for (let i = 0; i < 50; i++) {
      const b1 = calculateFullJitterBackoff(1, options);
      expect(b1).toBeGreaterThanOrEqual(0);
      expect(b1).toBeLessThanOrEqual(1000);

      const b2 = calculateFullJitterBackoff(2, options);
      expect(b2).toBeGreaterThanOrEqual(0);
      expect(b2).toBeLessThanOrEqual(2000);
    }
  });

  it("retry succeeds on attempt 3 with correct backoff ordering (use an injectable clock, not real sleeps)", async () => {
    const clock = new ManualClock(new Date("2030-01-01T00:00:00.000Z"));
    let attemptCounter = 0;
    const wfType = `flaky_${randomUUID().slice(0, 8)}`;

    const flakyWorkflow = async (ctx: Ctx) => {
      return await ctx.step(
        "unreliable-api",
        async (_input, stepCtx) => {
          attemptCounter++;
          if (attemptCounter < 3) {
            throw new Error(`Transient API failure on attempt ${attemptCounter}`);
          }
          return { done: true, attempt: stepCtx.attempt };
        },
        {},
        {
          maxAttempts: 3,
          initialBackoffMs: 1000,
          backoffMultiplier: 2,
          randomFn: () => 1.0, // predictable ceiling for ordering check
        },
      );
    };

    const engine = new Engine(pool, { [wfType]: flakyWorkflow }, clock);
    const worker = new Worker(engine, {
      workerId: `retry-worker-${randomUUID().slice(0, 8)}`,
      clock,
    });

    const runId = await engine.startRun(wfType, {});

    // Attempt 1 at T = 0ms
    const didAttempt1 = await worker.tick();
    expect(didAttempt1).toBe(true);
    expect(attemptCounter).toBe(1);

    // Check DB state after Attempt 1 failure
    const events1 = await loadEvents(pool, runId);
    const stepFailed1 = events1.find((e) => e.type === "StepFailed");
    expect(stepFailed1).toBeDefined();
    if (stepFailed1 && stepFailed1.type === "StepFailed") {
      expect(stepFailed1.payload.attempt).toBe(1);
      expect(stepFailed1.payload.error).toContain("attempt 1");
    }

    const { rows: tasks1 } = await pool.query<{
      status: string;
      run_at: Date;
      lease_owner: string | null;
    }>(
      `SELECT status, run_at, lease_owner FROM tasks WHERE run_id = $1 AND step_key = 'unreliable-api'`,
      [runId],
    );
    expect(tasks1[0]!.status).toBe("pending");
    expect(tasks1[0]!.lease_owner).toBeNull();
    const runAt1 = tasks1[0]!.run_at.getTime();
    expect(runAt1).toBe(new Date("2030-01-01T00:00:01.000Z").getTime()); // T + 1000ms

    // Verify backoff ordering: cannot claim before run_at1
    expect(await worker.tick()).toBe(false);
    clock.advance(500); // T + 500ms
    expect(await worker.tick()).toBe(false);

    // Attempt 2 at T = 1000ms
    clock.advance(500); // T + 1000ms (reaches runAt1)
    const didAttempt2 = await worker.tick();
    expect(didAttempt2).toBe(true);
    expect(attemptCounter).toBe(2);

    // Check DB state after Attempt 2 failure
    const events2 = await loadEvents(pool, runId);
    const stepFailedEvents = events2.filter((e) => e.type === "StepFailed");
    expect(stepFailedEvents.length).toBe(2);
    if (stepFailedEvents[1]?.type === "StepFailed") {
      expect(stepFailedEvents[1].payload.attempt).toBe(2);
    }

    const { rows: tasks2 } = await pool.query<{
      status: string;
      run_at: Date;
    }>(`SELECT status, run_at FROM tasks WHERE run_id = $1 AND step_key = 'unreliable-api'`, [
      runId,
    ]);
    const runAt2 = tasks2[0]!.run_at.getTime();
    expect(runAt2).toBe(new Date("2030-01-01T00:00:03.000Z").getTime()); // T1 + 2000ms

    // Assert exponential backoff ordering: backoff 1 (1000ms) < backoff 2 (2000ms)
    const backoff1 = runAt1 - new Date("2030-01-01T00:00:00.000Z").getTime();
    const backoff2 = runAt2 - runAt1;
    expect(backoff1).toBe(1000);
    expect(backoff2).toBe(2000);
    expect(backoff2).toBeGreaterThan(backoff1);

    // Cannot claim before runAt2
    expect(await worker.tick()).toBe(false);
    clock.advance(1000); // T + 2000ms (1000ms left before runAt2)
    expect(await worker.tick()).toBe(false);

    // Attempt 3 at T = 3000ms (reaches runAt2)
    clock.advance(1000); // T + 3000ms
    const didAttempt3 = await worker.tick();
    expect(didAttempt3).toBe(true);
    expect(attemptCounter).toBe(3);

    // Run completed on attempt 3
    const finalEvents = await loadEvents(pool, runId);
    const completedStep = finalEvents.find((e) => e.type === "StepCompleted");
    expect(completedStep).toBeDefined();
    if (completedStep && completedStep.type === "StepCompleted") {
      expect(completedStep.payload.result).toEqual({ done: true, attempt: 3 });
    }
    const runCompleted = finalEvents.find((e) => e.type === "RunCompleted");
    expect(runCompleted).toBeDefined();

    const { rows: runRows } = await pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [runId],
    );
    expect(runRows[0]!.status).toBe("completed");
  });

  it("retries survive a worker crash", async () => {
    const clock = new ManualClock(new Date("2030-02-01T00:00:00.000Z"));
    let executionAttempts = 0;
    const wfType = `crash_${randomUUID().slice(0, 8)}`;

    const crashWorkflow = async (ctx: Ctx) => {
      return await ctx.step(
        "step-survive-crash",
        async (_input, stepCtx) => {
          executionAttempts++;
          if (executionAttempts === 1) {
            throw new Error("Failure on first attempt before worker dies");
          }
          return { recovered: true, attempt: stepCtx.attempt };
        },
        {},
        {
          maxAttempts: 3,
          initialBackoffMs: 1000,
          randomFn: () => 1.0,
        },
      );
    };

    const engine = new Engine(pool, { [wfType]: crashWorkflow }, clock);
    const worker1 = new Worker(engine, {
      workerId: `worker-orig-${randomUUID().slice(0, 8)}`,
      clock,
    });

    const runId = await engine.startRun(wfType, {});

    // Worker 1 runs attempt 1 and fails
    await worker1.tick();
    expect(executionAttempts).toBe(1);

    // Verify retry state persisted in Postgres
    const eventsBeforeCrash = await loadEvents(pool, runId);
    expect(eventsBeforeCrash.some((e) => e.type === "StepFailed")).toBe(true);

    const { rows: taskRows } = await pool.query<{ status: string; lease_owner: string | null }>(
      `SELECT status, lease_owner FROM tasks WHERE run_id = $1 AND step_key = 'step-survive-crash'`,
      [runId],
    );
    expect(taskRows[0]!.status).toBe("pending");
    expect(taskRows[0]!.lease_owner).toBeNull();

    // Worker 1 crashes / is killed abruptly
    worker1.kill();
    expect(worker1.isKilled).toBe(true);

    // Advance clock past retry backoff
    clock.advance(1000);

    // Worker 2 (completely separate worker instance) starts up
    const worker2 = new Worker(engine, {
      workerId: `worker-repl-${randomUUID().slice(0, 8)}`,
      clock,
    });
    const didWork = await worker2.tick();
    expect(didWork).toBe(true);
    expect(executionAttempts).toBe(2);

    // Run completed successfully with worker 2
    const { rows: runRows } = await pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [runId],
    );
    expect(runRows[0]!.status).toBe("completed");

    const finalEvents = await loadEvents(pool, runId);
    const eventTypes = finalEvents.map((e) => e.type);
    expect(eventTypes).toEqual(["RunStarted", "StepFailed", "StepCompleted", "RunCompleted"]);
  });

  it("an exhausted step fails the run", async () => {
    const clock = new ManualClock(new Date("2030-03-01T00:00:00.000Z"));
    let attemptCount = 0;
    const wfType = `doomed_${randomUUID().slice(0, 8)}`;

    const doomedWorkflow = async (ctx: Ctx) => {
      return await ctx.step(
        "doomed-step",
        async () => {
          attemptCount++;
          throw new Error(`Permanent external outage (attempt ${attemptCount})`);
        },
        {},
        {
          maxAttempts: 2,
          initialBackoffMs: 500,
          randomFn: () => 1.0,
        },
      );
    };

    const engine = new Engine(pool, { [wfType]: doomedWorkflow }, clock);
    const worker = new Worker(engine, {
      workerId: `exhaust-worker-${randomUUID().slice(0, 8)}`,
      clock,
    });

    const runId = await engine.startRun(wfType, {});

    // Attempt 1 fails
    await worker.tick();
    expect(attemptCount).toBe(1);

    // Advance clock to scheduled retry
    clock.advance(500);

    // Attempt 2 fails and exhausts maxAttempts (2 of 2)
    await worker.tick();
    expect(attemptCount).toBe(2);

    // Assert task and run are marked failed
    const { rows: taskRows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE run_id = $1 AND step_key = 'doomed-step'`,
      [runId],
    );
    expect(taskRows[0]!.status).toBe("failed");

    const { rows: runRows } = await pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [runId],
    );
    expect(runRows[0]!.status).toBe("failed");

    // Events check
    const events = await loadEvents(pool, runId);
    const failedSteps = events.filter((e) => e.type === "StepFailed");
    expect(failedSteps.length).toBe(2);
    if (failedSteps[0]?.type === "StepFailed" && failedSteps[1]?.type === "StepFailed") {
      expect(failedSteps[0].payload.attempt).toBe(1);
      expect(failedSteps[1].payload.attempt).toBe(2);
    }
    const runFailed = events.find((e) => e.type === "RunFailed");
    expect(runFailed).toBeDefined();

    // Direct execute on failed run returns { status: "failed" }
    const outcome = await engine.execute(runId);
    expect(outcome.status).toBe("failed");
  });

  it("idempotency keys differ between a run and its fork-ready copy", async () => {
    const recordedKeys: Record<string, string> = {};
    const wfType = `payment_${randomUUID().slice(0, 8)}`;

    const wf = async (ctx: Ctx) => {
      return await ctx.step(
        "charge-payment",
        async (_input, stepCtx) => {
          recordedKeys[stepCtx.idempotencyKey] = stepCtx.idempotencyKey;
          return { key: stepCtx.idempotencyKey };
        },
        {},
      );
    };

    const engine = new Engine(pool, { [wfType]: wf });

    // Original run
    const runId1 = await engine.startRun(wfType, {});
    const out1 = await engine.execute(runId1);
    expect(out1.status).toBe("completed");

    // Fork-ready copy run
    const runId2 = await engine.startRun(wfType, {});
    const out2 = await engine.execute(runId2);
    expect(out2.status).toBe("completed");

    const key1 = makeIdempotencyKey(runId1, "charge-payment");
    const key2 = makeIdempotencyKey(runId2, "charge-payment");

    expect(key1).toBe(`${runId1}:charge-payment`);
    expect(key2).toBe(`${runId2}:charge-payment`);
    expect(key1).not.toBe(key2);

    expect(recordedKeys[key1]).toBe(key1);
    expect(recordedKeys[key2]).toBe(key2);
  });

  it("step timeout aborts step execution and counts as a failed attempt", async () => {
    let callCount = 0;
    let signalWasAborted = false;
    const wfType = `timeout_${randomUUID().slice(0, 8)}`;

    const timeoutWorkflow = async (ctx: Ctx) => {
      return await ctx.step(
        "slow-operation",
        async (_input, stepCtx) => {
          callCount++;
          if (callCount === 1) {
            // Wait longer than timeoutMs
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 200);
              stepCtx.signal.addEventListener("abort", () => {
                signalWasAborted = true;
                clearTimeout(timer);
                resolve(null);
              });
            });
            throw new Error("Should have been aborted");
          }
          return { success: true };
        },
        {},
        {
          timeoutMs: 40,
          maxAttempts: 2,
          initialBackoffMs: 10,
        },
      );
    };

    const engine = new Engine(pool, { [wfType]: timeoutWorkflow });
    const runId = await engine.startRun(wfType, {});

    // Attempt 1 will time out
    const outcome1 = await engine.execute(runId);
    expect(outcome1.status).toBe("running");
    expect(signalWasAborted).toBe(true);
    expect(callCount).toBe(1);

    // Wait for the tiny 10ms backoff
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Attempt 2 succeeds
    const outcome2 = await engine.execute(runId);
    expect(outcome2.status).toBe("completed");
    expect(callCount).toBe(2);

    const events = await loadEvents(pool, runId);
    const failedEvent = events.find((e) => e.type === "StepFailed");
    expect(failedEvent).toBeDefined();
    if (failedEvent && failedEvent.type === "StepFailed") {
      expect(failedEvent.payload.error).toContain("timed out after 40ms");
      expect(failedEvent.payload.attempt).toBe(1);
    }
  });

  it("reaper reschedules task when lease expires while step is running", async () => {
    const clock = new ManualClock(new Date("2030-04-01T00:00:00.000Z"));
    const engine = new Engine(pool, {}, clock);
    const wfType = `reap_${randomUUID().slice(0, 8)}`;

    // Insert an active running task with lease expired
    const { rows: runRows } = await pool.query<{ id: string }>(
      `INSERT INTO runs (workflow_type, input) VALUES ($1, '{}') RETURNING id`,
      [wfType],
    );
    const runId = runRows[0]!.id;

    const { rows: taskRows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (run_id, step_key, status, lease_owner, lease_expires_at, attempt)
       VALUES ($1, 'reap-step', 'running', 'dead-worker', $2, 1) RETURNING id`,
      [runId, new Date("2030-04-01T00:00:05.000Z")],
    );
    const taskId = taskRows[0]!.id;

    // Before expiration, reaper does not reap
    const reaped0 = await reapTasks(pool, new Date("2030-04-01T00:00:00.000Z"), [wfType]);
    expect(reaped0).not.toContain(taskId);

    // After expiration at T = 6s, reaper reschedules it to pending
    const reaped1 = await engine.reap(new Date("2030-04-01T00:00:06.000Z"), [wfType]);
    expect(reaped1).toContain(taskId);

    const { rows: afterReap } = await pool.query<{ status: string; lease_owner: string | null }>(
      `SELECT status, lease_owner FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(afterReap[0]!.status).toBe("pending");
    expect(afterReap[0]!.lease_owner).toBeNull();
  });
});

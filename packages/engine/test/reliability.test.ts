import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import { type Ctx, makeIdempotencyKey, RunContext } from "../src/context.js";
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
    // 1. Assert ceilings separately (using max randomFn = 1.0)
    expect(calculateFullJitterBackoff(1, { ...options, randomFn: () => 1.0 })).toBe(1000);
    expect(calculateFullJitterBackoff(2, { ...options, randomFn: () => 1.0 })).toBe(2000);
    expect(calculateFullJitterBackoff(3, { ...options, randomFn: () => 1.0 })).toBe(4000);
    expect(calculateFullJitterBackoff(4, { ...options, randomFn: () => 1.0 })).toBe(8000);
    expect(calculateFullJitterBackoff(5, { ...options, randomFn: () => 1.0 })).toBe(8000);

    // 2. Assert each delay lies in [0, ceiling] over many seeded draws
    let seed = 123456789;
    const seededRandom = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 200; i++) {
      const b1 = calculateFullJitterBackoff(1, { ...options, randomFn: seededRandom });
      expect(b1).toBeGreaterThanOrEqual(0);
      expect(b1).toBeLessThanOrEqual(1000);

      const b2 = calculateFullJitterBackoff(2, { ...options, randomFn: seededRandom });
      expect(b2).toBeGreaterThanOrEqual(0);
      expect(b2).toBeLessThanOrEqual(2000);

      const b3 = calculateFullJitterBackoff(3, { ...options, randomFn: seededRandom });
      expect(b3).toBeGreaterThanOrEqual(0);
      expect(b3).toBeLessThanOrEqual(4000);
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

    const key1 = makeIdempotencyKey(runId1, "charge-payment", 0);
    const key2 = makeIdempotencyKey(runId2, "charge-payment", 0);

    expect(key1).toBe(`${runId1}:charge-payment:0`);
    expect(key2).toBe(`${runId2}:charge-payment:0`);
    expect(key1).not.toBe(key2);

    expect(recordedKeys[key1]).toBe(key1);
    expect(recordedKeys[key2]).toBe(key2);
  });

  it("pins idempotency key derivation: same run+step+occurrence gives the same key across a retry; different runs give different keys", async () => {
    const runId1 = "run-test-uuid-1111";
    const runId2 = "run-test-uuid-2222";
    const stepName = "charge-card";

    // 1. Direct function contract: makeIdempotencyKey(runId, stepKey, occurrence) === `${runId}:${stepKey}:${occurrence}`
    expect(makeIdempotencyKey(runId1, stepName, 0)).toBe(`${runId1}:${stepName}:0`);
    expect(makeIdempotencyKey(runId2, stepName, 0)).toBe(`${runId2}:${stepName}:0`);
    expect(makeIdempotencyKey(runId1, stepName, 1)).toBe(`${runId1}:${stepName}:1`);
    expect(makeIdempotencyKey(runId1, stepName, 0)).not.toBe(
      makeIdempotencyKey(runId2, stepName, 0),
    );
    expect(makeIdempotencyKey(runId1, stepName, 0)).not.toBe(
      makeIdempotencyKey(runId1, stepName, 1),
    );

    // 2. Execution-level verification across step retries
    const keysSeenOnAttempts: string[] = [];
    let attemptCount = 0;
    const wfType = `wf_idem_pin_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfType]: async (ctx: Ctx) => {
        return await ctx.step(
          stepName,
          async (_inp, sctx) => {
            attemptCount++;
            keysSeenOnAttempts.push(sctx.idempotencyKey);
            if (attemptCount === 1) {
              throw new Error("transient network failure on attempt 1");
            }
            return { ok: true };
          },
          {},
          { maxAttempts: 3, initialBackoffMs: 0 },
        );
      },
    });

    const liveRunId = await engine.startRun(wfType, {});
    const res1 = await engine.execute(liveRunId);
    expect(res1.status).toBe("running");
    expect(attemptCount).toBe(1);

    const res2 = await engine.execute(liveRunId);
    expect(res2.status).toBe("completed");
    expect(attemptCount).toBe(2);
    expect(keysSeenOnAttempts.length).toBe(2);

    // Same run + step + occurrence produces identical idempotency key across retries
    expect(keysSeenOnAttempts[0]).toBe(`${liveRunId}:${stepName}:0`);
    expect(keysSeenOnAttempts[1]).toBe(`${liveRunId}:${stepName}:0`);
    expect(keysSeenOnAttempts[0]).toBe(keysSeenOnAttempts[1]);

    // Different run produces different idempotency key
    const otherRunId = await engine.startRun(wfType, {});
    const otherKey = makeIdempotencyKey(otherRunId, stepName, 0);
    expect(otherKey).toBe(`${otherRunId}:${stepName}:0`);
    expect(otherKey).not.toBe(keysSeenOnAttempts[0]);
  });

  it("occurrence-indexed idempotency keys: two occurrences get different keys; retry of occurrence 1 keeps occurrence 1's key", async () => {
    const keysSeen: { occ0: string[]; occ1: string[] } = {
      occ0: [],
      occ1: [],
    };
    let occ1Attempts = 0;
    const wfType = `wf_multi_occ_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfType]: async (ctx: Ctx) => {
        // Occurrence 0
        await ctx.step(
          "transfer-funds",
          async (_inp, sctx) => {
            keysSeen.occ0.push(sctx.idempotencyKey);
            return { transferred: 100 };
          },
          {},
        );

        // Occurrence 1 (fails once, retries, then succeeds)
        await ctx.step(
          "transfer-funds",
          async (_inp, sctx) => {
            occ1Attempts++;
            keysSeen.occ1.push(sctx.idempotencyKey);
            if (occ1Attempts === 1) {
              throw new Error("transient network failure on occurrence 1 attempt 1");
            }
            return { transferred: 200 };
          },
          {},
          { maxAttempts: 3, initialBackoffMs: 0 },
        );
      },
    });

    const runId = await engine.startRun(wfType, {});
    // Attempt 1: occurrence 0 succeeds, occurrence 1 fails and schedules retry
    const res1 = await engine.execute(runId);
    expect(res1.status).toBe("running");
    expect(occ1Attempts).toBe(1);

    // Attempt 2: occurrence 0 returned from replay, occurrence 1 retries live and succeeds
    const res2 = await engine.execute(runId);
    expect(res2.status).toBe("completed");
    expect(occ1Attempts).toBe(2);

    // Assert: two occurrences get different keys
    const occ0Key = `${runId}:transfer-funds:0`;
    const occ1Key = `${runId}:transfer-funds:1`;
    expect(keysSeen.occ0).toEqual([occ0Key]);
    expect(occ0Key).not.toBe(occ1Key);

    // Assert: retry of occurrence 1 keeps occurrence 1's key exactly
    expect(keysSeen.occ1.length).toBe(2);
    expect(keysSeen.occ1[0]).toBe(occ1Key);
    expect(keysSeen.occ1[1]).toBe(occ1Key);
    expect(keysSeen.occ1[0]).toBe(keysSeen.occ1[1]);
  });

  it("fork idempotency keys differ from parent run for matching step and occurrence", async () => {
    const parentKeys: string[] = [];
    const forkKeys: string[] = [];
    const wfType = `wf_fork_idem_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfType]: async (ctx: Ctx) => {
        await ctx.step("step-one", () => ({ done: true }), {});
        await ctx.step(
          "external-call",
          async (_inp, sctx) => {
            if (sctx.idempotencyKey.includes("fork")) {
              forkKeys.push(sctx.idempotencyKey);
            } else {
              parentKeys.push(sctx.idempotencyKey);
            }
            return { status: "ok" };
          },
          {},
        );
      },
    });

    const parentRunId = await engine.startRun(wfType, {});
    await engine.execute(parentRunId);

    // Fork at step 2 (occurrence 0 of external-call)
    const forkedRunId = await engine.fork(parentRunId, 2, { input: {} });
    await engine.execute(forkedRunId);

    expect(parentRunId).not.toBe(forkedRunId);
    expect(makeIdempotencyKey(parentRunId, "external-call", 0)).toBe(
      `${parentRunId}:external-call:0`,
    );
    expect(makeIdempotencyKey(forkedRunId, "external-call", 0)).toBe(
      `${forkedRunId}:external-call:0`,
    );
    expect(makeIdempotencyKey(parentRunId, "external-call", 0)).not.toBe(
      makeIdempotencyKey(forkedRunId, "external-call", 0),
    );
  });

  it("repeated step names in one run and in a loop receive distinct occurrence-indexed idempotency keys", async () => {
    const keys: Record<string, string> = {};
    const wfType = `repeated_step_fixed_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfType]: async (ctx: Ctx) => {
        await ctx.step(
          "charge-card",
          async (_inp, sctx) => {
            keys.sequential_1 = sctx.idempotencyKey;
            return { ok: true };
          },
          {},
        );
        await ctx.step(
          "charge-card",
          async (_inp, sctx) => {
            keys.sequential_2 = sctx.idempotencyKey;
            return { ok: true };
          },
          {},
        );
        for (let i = 0; i < 2; i++) {
          await ctx.step(
            "loop-step",
            async (_inp, sctx) => {
              keys[`loop_${i}`] = sctx.idempotencyKey;
              return { i };
            },
            {},
          );
        }
      },
    });

    const runId = await engine.startRun(wfType, {});
    await engine.execute(runId);
    expect(keys.sequential_1).toBe(`${runId}:charge-card:0`);
    expect(keys.sequential_2).toBe(`${runId}:charge-card:1`);
    expect(keys.sequential_1).not.toBe(keys.sequential_2);
    expect(keys.loop_0).toBe(`${runId}:loop-step:0`);
    expect(keys.loop_1).toBe(`${runId}:loop-step:1`);
    expect(keys.loop_0).not.toBe(keys.loop_1);
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
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    await pool.query(`DELETE FROM runs WHERE id = $1`, [runId]);
  });

  it("replay-with-retries: replaying from history does not re-execute step and preserves live result and valid event sequence", async () => {
    const clock = new ManualClock(new Date("2030-05-01T00:00:00.000Z"));
    let executionCount = 0;
    const wfType = `replay_retry_${randomUUID().slice(0, 8)}`;

    const retryWorkflow = async (ctx: Ctx, input: { num: number }) => {
      const stepRes = await ctx.step(
        "flaky-step",
        async (n: number) => {
          executionCount++;
          if (executionCount < 3) {
            throw new Error(`Flaky failure ${executionCount}`);
          }
          return { value: n * 10, attempt: executionCount };
        },
        input.num,
        {
          maxAttempts: 3,
          initialBackoffMs: 1000,
          randomFn: () => 1.0,
        },
      );
      return { final: stepRes.value };
    };

    const engine = new Engine(pool, { [wfType]: retryWorkflow }, clock);
    const runId = await engine.startRun(wfType, { num: 42 });

    // Attempt 1 fails
    await engine.execute(runId);
    expect(executionCount).toBe(1);

    // Advance clock past backoff 1 (1000ms)
    clock.advance(1000);
    // Attempt 2 fails
    await engine.execute(runId);
    expect(executionCount).toBe(2);

    // Advance clock past backoff 2 (2000ms)
    clock.advance(2000);
    // Attempt 3 succeeds
    const liveOutcome = await engine.execute(runId);
    expect(liveOutcome.status).toBe("completed");
    if (liveOutcome.status === "completed") {
      expect(liveOutcome.result).toEqual({ final: 420 });
    }
    expect(executionCount).toBe(3);

    // Verify event sequence after live run
    const events = await loadEvents(pool, runId);
    expect(events.map((e) => e.type)).toEqual([
      "RunStarted",
      "StepFailed",
      "StepFailed",
      "StepCompleted",
      "RunCompleted",
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    // Replay in a fresh worker / context from history
    let replayExecutionCount = 0;
    const replayWorkflowFn = async (ctx: Ctx, input: { num: number }) => {
      const stepRes = await ctx.step(
        "flaky-step",
        async (n: number) => {
          replayExecutionCount++;
          return { value: n * 10, attempt: replayExecutionCount };
        },
        input.num,
        {
          maxAttempts: 3,
          initialBackoffMs: 1000,
        },
      );
      return { final: stepRes.value };
    };

    const history = events.filter((e) => e.type !== "RunStarted");
    const replayCtx = new RunContext(pool, runId, history, { clock });
    const replayResult = await replayWorkflowFn(replayCtx, { num: 42 });

    // Step function was NOT re-executed during replay!
    expect(replayExecutionCount).toBe(0);
    // Result matches live result
    expect(replayResult).toEqual({ final: 420 });
  });

  it("abandoned attempt: late resolution of step that ignores AbortSignal writes NO event and does not corrupt retry", async () => {
    let attemptCount = 0;
    let lateResolutionDone = false;
    let lateResolutionValue: string | null = null;
    const wfType = `abandoned_${randomUUID().slice(0, 8)}`;

    const abandonedWorkflow = async (ctx: Ctx) => {
      return await ctx.step(
        "slow-step",
        async (_input, _sctx) => {
          attemptCount++;
          if (attemptCount === 1) {
            // Attempt 1 ignores AbortSignal and resolves late after timeout
            return new Promise<{ res: string }>((resolve) => {
              setTimeout(() => {
                lateResolutionValue = "rogue-late-result";
                lateResolutionDone = true;
                resolve({ res: lateResolutionValue });
              }, 120);
            });
          }
          return { res: "clean-attempt-2" };
        },
        {},
        {
          timeoutMs: 40,
          maxAttempts: 2,
          initialBackoffMs: 10,
        },
      );
    };

    const engine = new Engine(pool, { [wfType]: abandonedWorkflow });
    const runId = await engine.startRun(wfType, {});

    // Attempt 1 executes and times out after 40ms
    const outcome1 = await engine.execute(runId);
    expect(outcome1.status).toBe("running");
    expect(attemptCount).toBe(1);

    // Wait past the 10ms backoff
    await new Promise((r) => setTimeout(r, 25));

    // Attempt 2 executes and succeeds
    const outcome2 = await engine.execute(runId);
    expect(outcome2.status).toBe("completed");
    if (outcome2.status === "completed") {
      expect(outcome2.result).toEqual({ res: "clean-attempt-2" });
    }
    expect(attemptCount).toBe(2);

    // Now wait for attempt 1's late promise to resolve in the background (120ms total)
    await new Promise((r) => setTimeout(r, 120));
    expect(lateResolutionDone).toBe(true);
    expect(lateResolutionValue).toBe("rogue-late-result");

    // Assert the events table: exactly one StepCompleted with attempt 2's clean result, NO rogue event
    const events = await loadEvents(pool, runId);
    expect(events.map((e) => e.type)).toEqual([
      "RunStarted",
      "StepFailed",
      "StepCompleted",
      "RunCompleted",
    ]);

    const stepCompletedEvent = events.find((e) => e.type === "StepCompleted");
    expect(stepCompletedEvent).toBeDefined();
    const cleanPayload = stepCompletedEvent!.payload as { result: { res: string } };
    expect(cleanPayload.result).toEqual({
      res: "clean-attempt-2",
    });

    // Assert that rogue late result is nowhere in the database events
    const allPayloads = JSON.stringify(events.map((e) => e.payload));
    expect(allPayloads).not.toContain("rogue-late-result");
  });

  it("resumes a failed run after maxAttempts exhausted: earlier steps do not re-run, failed step retries live, and events are purely append-only", async () => {
    let step1Calls = 0;
    let step2Calls = 0;
    let shouldFailStep2 = true;
    const wfType = `failed_resume_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wfType]: async (ctx: Ctx) => {
        const r1 = await ctx.step(
          "step-one",
          () => {
            step1Calls++;
            return "step-1-done";
          },
          {},
        );

        const r2 = await ctx.step(
          "step-two",
          () => {
            step2Calls++;
            if (shouldFailStep2) {
              throw new Error("Step 2 exhausted failure");
            }
            return "step-2-succeeded";
          },
          {},
          { maxAttempts: 1 },
        );

        return { r1, r2 };
      },
    });

    // 1. Initial run: step 1 succeeds, step 2 fails and exhausts maxAttempts (1)
    const runId = await engine.startRun(wfType, {});
    const initialOutcome = await engine.execute(runId);
    expect(initialOutcome.status).toBe("failed");
    expect(step1Calls).toBe(1);
    expect(step2Calls).toBe(1);

    // Verify initial event sequence: RunStarted -> StepCompleted -> StepFailed -> RunFailed
    const initialEvents = await loadEvents(pool, runId);
    expect(initialEvents.map((e) => e.type)).toEqual([
      "RunStarted",
      "StepCompleted",
      "StepFailed",
      "RunFailed",
    ]);

    // 2. Fix the transient root cause for step 2
    shouldFailStep2 = false;

    // 3. Resume the failed run with fresh attempt budget
    const resumeOutcome = await engine.execute(runId, { resumeFailed: true });
    expect(resumeOutcome.status).toBe("completed");
    if (resumeOutcome.status === "completed") {
      expect(resumeOutcome.result).toEqual({
        r1: "step-1-done",
        r2: "step-2-succeeded",
      });
    }

    // 4. Assert invariants:
    // (a) Earlier completed step 1 was NOT re-executed
    expect(step1Calls).toBe(1);

    // (b) Failed step 2 ran again live
    expect(step2Calls).toBe(2);

    // (c) Events table: strictly append-only, NO events deleted or edited
    const finalEvents = await loadEvents(pool, runId);
    console.log(
      "Resumed run full event sequence:\n" +
        finalEvents
          .map((e) => `  [seq ${e.seq}] ${e.type} -> ${JSON.stringify(e.payload)}`)
          .join("\n"),
    );
    const eventTypes = finalEvents.map((e) => e.type);
    expect(eventTypes).toEqual([
      "RunStarted",
      "StepCompleted",
      "StepFailed",
      "RunFailed",
      "RunResumed",
      "StepCompleted",
      "RunCompleted",
    ]);

    // Verify sequences are strictly contiguous 1..7 with no gaps or modifications
    expect(finalEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Verify RunResumed payload points back to the failed event sequence
    const resumedEvent = finalEvents.find((e) => e.type === "RunResumed");
    expect(resumedEvent).toBeDefined();
    expect((resumedEvent!.payload as { fromSeq: number }).fromSeq).toBe(4);

    // (d) Task state in tasks table: both steps have tasks, all completed
    const { rows: taskRows } = await pool.query<{
      step_key: string;
      status: string;
      attempt: number;
    }>("SELECT step_key, status, attempt FROM tasks WHERE run_id = $1 ORDER BY id ASC", [runId]);
    expect(taskRows.length).toBe(2);
    expect(taskRows.every((t) => t.status === "completed")).toBe(true);

    // Clean up
    await pool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
  });

  it("failed-run resume provides a fresh attempt budget (step fails once after resume, retries, and succeeds on attempt 2)", async () => {
    const clock = new ManualClock(new Date("2030-01-01T00:00:00.000Z"));
    let step1Calls = 0;
    let step2Calls = 0;
    // Step 2 will fail 2 times initially (exhausting maxAttempts: 2)
    // Then on resume, it will fail 1 more time before succeeding on attempt 2
    let failuresRemaining = 3;

    const wfType = `wf_fresh_attempt_budget_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(
      pool,
      {
        [wfType]: async (ctx: Ctx) => {
          const r1 = await ctx.step(
            "step-1",
            () => {
              step1Calls++;
              return "step-1-done";
            },
            {},
          );

          const r2 = await ctx.step(
            "step-2",
            () => {
              step2Calls++;
              if (failuresRemaining > 0) {
                failuresRemaining--;
                throw new Error(`Transient failure (${step2Calls})`);
              }
              return "step-2-done";
            },
            {},
            {
              maxAttempts: 2,
              initialBackoffMs: 100,
              backoffMultiplier: 2,
              randomFn: () => 1.0,
            },
          );

          return { r1, r2 };
        },
      },
      clock,
    );

    // 1. Initial run: step 1 succeeds, step 2 fails attempt 1, schedules retry
    const runId = await engine.startRun(wfType, {});
    let outcome = await engine.execute(runId);
    expect(outcome.status).toBe("running");
    expect(step1Calls).toBe(1);
    expect(step2Calls).toBe(1);
    expect(failuresRemaining).toBe(2);

    // Advance clock past retry backoff and run attempt 2 -> exhausts maxAttempts (2) -> fails run
    clock.advance(200);
    outcome = await engine.execute(runId);
    expect(outcome.status).toBe("failed");
    expect(step1Calls).toBe(1);
    expect(step2Calls).toBe(2);
    expect(failuresRemaining).toBe(1); // 1 failure still remaining

    const eventsBefore = await loadEvents(pool, runId);
    expect(eventsBefore.map((e) => e.type)).toEqual([
      "RunStarted",
      "StepCompleted",
      "StepFailed",
      "StepFailed",
      "RunFailed",
    ]);

    // 2. Resume run: step 2 gets fresh budget of 2 attempts.
    // It fails on attempt 1 after resume (failuresRemaining becomes 0), schedules retry
    outcome = await engine.execute(runId, { resumeFailed: true });
    expect(outcome.status).toBe("running");
    expect(step1Calls).toBe(1); // Step 1 never re-executed
    expect(step2Calls).toBe(3); // 2 in first run + 1 in resumed run
    expect(failuresRemaining).toBe(0);

    // Advance clock past retry backoff and run attempt 2 after resume -> succeeds!
    clock.advance(200);
    outcome = await engine.execute(runId);
    expect(outcome.status).toBe("completed");
    expect(step1Calls).toBe(1); // Still 1
    expect(step2Calls).toBe(4); // 2 in first run + 2 in resumed run
    if (outcome.status === "completed") {
      expect(outcome.result).toEqual({ r1: "step-1-done", r2: "step-2-done" });
    }

    const eventsAfter = await loadEvents(pool, runId);
    console.log(
      "Fresh attempt budget event sequence:\n" +
        eventsAfter
          .map((e) => `  [seq ${e.seq}] ${e.type} -> ${JSON.stringify(e.payload)}`)
          .join("\n"),
    );
    const eventTypes = eventsAfter.map((e) => e.type);
    expect(eventTypes).toEqual([
      "RunStarted",
      "StepCompleted",
      "StepFailed",
      "StepFailed",
      "RunFailed",
      "RunResumed",
      "StepFailed",
      "StepCompleted",
      "RunCompleted",
    ]);

    // Verify sequences are strictly contiguous 1..9 with no gaps or modifications
    expect(eventsAfter.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Clean up
    await pool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
  });
});

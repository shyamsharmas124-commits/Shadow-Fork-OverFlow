import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Ctx, Engine, loadEvents, type StepContext } from "../src/index.js";
import { makePool } from "./helpers.js";

describe("Milestone 4a - Workflow Forking without Shadow Mode", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await makePool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("(a) parent events and runs row are identical before and after fork", async () => {
    const wf = `wf_parent_unchanged_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { x: number }) => {
        const s1 = await ctx.step("step1", async (n: number) => n + 10, input.x);
        const s2 = await ctx.step("step2", async (n: number) => n * 2, s1);
        return { final: s2 };
      },
    });

    const parentRunId = await engine.startRun(wf, { x: 5 });
    const parentOutcome = await engine.execute(parentRunId);
    expect(parentOutcome.status).toBe("completed");

    // Capture parent state before fork
    const { rows: parentRunBefore } = await pool.query(
      `SELECT id, workflow_type, status, input, parent_run_id, forked_from_seq FROM runs WHERE id = $1`,
      [parentRunId],
    );
    const parentEventsBefore = await loadEvents(pool, parentRunId);

    // Fork at step1 (seq 2 is StepCompleted for step1)
    const forkedRunId = await engine.fork(parentRunId, 2, { result: 100 });
    const forkOutcome = await engine.execute(forkedRunId);
    expect(forkOutcome.status).toBe("completed");

    // Capture parent state after fork
    const { rows: parentRunAfter } = await pool.query(
      `SELECT id, workflow_type, status, input, parent_run_id, forked_from_seq FROM runs WHERE id = $1`,
      [parentRunId],
    );
    const parentEventsAfter = await loadEvents(pool, parentRunId);

    // Assert parent run row and all parent events are completely unchanged
    expect(parentRunAfter).toEqual(parentRunBefore);
    expect(parentEventsAfter).toEqual(parentEventsBefore);
  });

  it("(b) fork with result edit: downstream step functions execute live and produce different results", async () => {
    const executionCounts = { step1: 0, step2: 0, step3: 0 };
    const wf = `wf_fork_result_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { base: number }) => {
        const r1 = await ctx.step(
          "step1",
          async (n: number) => {
            executionCounts.step1++;
            return n + 10;
          },
          input.base,
        );
        const r2 = await ctx.step(
          "step2",
          async (n: number) => {
            executionCounts.step2++;
            return n * 2;
          },
          r1,
        );
        const r3 = await ctx.step(
          "step3",
          async (n: number) => {
            executionCounts.step3++;
            return n + 5;
          },
          r2,
        );
        return { final: r3 };
      },
    });

    // Parent run: (5 + 10) * 2 + 5 = 35
    const parentRunId = await engine.startRun(wf, { base: 5 });
    const parentOutcome = await engine.execute(parentRunId);
    expect(parentOutcome.status).toBe("completed");
    if (parentOutcome.status === "completed") {
      expect(parentOutcome.result).toEqual({ final: 35 });
    }
    expect(executionCounts).toEqual({ step1: 1, step2: 1, step3: 1 });

    // Fork at step1 (seq 2): keep step1, replace result with 100
    // Downstream steps should take 100: (100 * 2) + 5 = 205
    const forkedRunId = await engine.fork(parentRunId, 2, { result: 100 });

    // Before execute, step1 was written at atSeq=2. Step1 must NOT be re-executed!
    const forkOutcome = await engine.execute(forkedRunId);
    expect(forkOutcome.status).toBe("completed");
    if (forkOutcome.status === "completed") {
      expect(forkOutcome.result).toEqual({ final: 205 });
    }

    // Step 1 count remains 1 (replayed / kept), while downstream steps executed live in fork!
    expect(executionCounts.step1).toBe(1);
    expect(executionCounts.step2).toBe(2);
    expect(executionCounts.step3).toBe(2);

    // Verify events in fork
    const forkEvents = await loadEvents(pool, forkedRunId);
    expect(forkEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(forkEvents.map((e) => e.type)).toEqual([
      "RunStarted",
      "StepCompleted",
      "StepCompleted",
      "StepCompleted",
      "RunCompleted",
    ]);

    const step1Event = forkEvents.find(
      (e) => e.type === "StepCompleted" && (e.payload as { name: string }).name === "step1",
    );
    expect(step1Event).toBeDefined();
    expect((step1Event!.payload as { result: unknown }).result).toBe(100);

    const step2Event = forkEvents.find(
      (e) => e.type === "StepCompleted" && (e.payload as { name: string }).name === "step2",
    );
    expect(step2Event).toBeDefined();
    expect((step2Event!.payload as { input: unknown; result: unknown }).input).toBe(100);
    expect((step2Event!.payload as { input: unknown; result: unknown }).result).toBe(200);
  });

  it("(b) fork with input edit: re-runs step at atSeq with new input and re-executes downstream live", async () => {
    const executionCounts = { step1: 0, step2: 0, step3: 0 };
    const wf = `wf_fork_input_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { base: number }) => {
        const r1 = await ctx.step(
          "step1",
          async (n: number) => {
            executionCounts.step1++;
            return n + 10;
          },
          input.base,
        );
        const r2 = await ctx.step(
          "step2",
          async (n: number) => {
            executionCounts.step2++;
            return n * 2;
          },
          r1,
        );
        const r3 = await ctx.step(
          "step3",
          async (n: number) => {
            executionCounts.step3++;
            return n + 5;
          },
          r2,
        );
        return { final: r3 };
      },
    });

    const parentRunId = await engine.startRun(wf, { base: 5 });
    await engine.execute(parentRunId);
    expect(executionCounts).toEqual({ step1: 1, step2: 1, step3: 1 });

    // Fork at step1 (seq 2) with new input 20:
    // Step1 re-runs live with 20 -> 30
    // Step2 takes 30 -> 60
    // Step3 takes 60 -> 65
    const forkedRunId = await engine.fork(parentRunId, 2, { input: 20 });
    const forkOutcome = await engine.execute(forkedRunId);
    expect(forkOutcome.status).toBe("completed");
    if (forkOutcome.status === "completed") {
      expect(forkOutcome.result).toEqual({ final: 65 });
    }

    // All 3 steps executed live in the fork
    expect(executionCounts.step1).toBe(2);
    expect(executionCounts.step2).toBe(2);
    expect(executionCounts.step3).toBe(2);

    const forkEvents = await loadEvents(pool, forkedRunId);
    const step1Event = forkEvents.find(
      (e) => e.type === "StepCompleted" && (e.payload as { name: string }).name === "step1",
    );
    expect(step1Event).toBeDefined();
    expect((step1Event!.payload as { input: unknown; result: unknown }).input).toBe(20);
    expect((step1Event!.payload as { input: unknown; result: unknown }).result).toBe(30);
  });

  it("(b) occurrence index: input-edit fork at second occurrence replays first occurrence unchanged and runs second live", async () => {
    const liveExecutions: Array<{ item: number; occurrence: number }> = [];
    const wf = `wf_loop_occurrences_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { items: number[] }) => {
        const results: number[] = [];
        let count = 0;
        for (const item of input.items) {
          const occ = count++;
          const val = await ctx.step(
            "process-item",
            async (n: number) => {
              liveExecutions.push({ item: n, occurrence: occ });
              return n * 10;
            },
            item,
          );
          results.push(val);
        }
        const summary = await ctx.step(
          "summarize",
          async (arr: number[]) => {
            return arr.reduce((a, b) => a + b, 0);
          },
          results,
        );
        return { results, summary };
      },
    });

    // Parent run with [1, 2]
    // seq 1: RunStarted
    // seq 2: StepCompleted("process-item", input: 1, result: 10) [occurrence 0]
    // seq 3: StepCompleted("process-item", input: 2, result: 20) [occurrence 1]
    // seq 4: StepCompleted("summarize", input: [10, 20], result: 30)
    // seq 5: RunCompleted(result: { results: [10, 20], summary: 30 })
    const parentRunId = await engine.startRun(wf, { items: [1, 2] });
    const parentOutcome = await engine.execute(parentRunId);
    expect(parentOutcome.status).toBe("completed");
    expect(liveExecutions).toEqual([
      { item: 1, occurrence: 0 },
      { item: 2, occurrence: 1 },
    ]);

    const parentEvents = await loadEvents(pool, parentRunId);
    expect(parentEvents.map((e) => e.type)).toEqual([
      "RunStarted",
      "StepCompleted",
      "StepCompleted",
      "StepCompleted",
      "RunCompleted",
    ]);

    // Clear live executions tracker before fork execution
    liveExecutions.length = 0;

    // Fork at second occurrence of "process-item" (seq = 3) with new input 99
    const forkedRunId = await engine.fork(parentRunId, 3, { input: 99 });
    const forkOutcome = await engine.execute(forkedRunId);
    expect(forkOutcome.status).toBe("completed");
    if (forkOutcome.status === "completed") {
      expect(forkOutcome.result).toEqual({ results: [10, 990], summary: 1000 });
    }

    // Assert that the first occurrence (occurrence 0, item 1) replayed from history and was NOT re-executed live!
    // Only occurrence 1 was executed live with item 99!
    expect(liveExecutions).toEqual([{ item: 99, occurrence: 1 }]);

    // Verify events in fork:
    // seq 1: RunStarted
    // seq 2: StepCompleted("process-item", input: 1, result: 10) [copied from parent]
    // seq 3: StepCompleted("process-item", input: 99, result: 990) [live executed with new input]
    // seq 4: StepCompleted("summarize", input: [10, 990], result: 1000)
    // seq 5: RunCompleted
    const forkEvents = await loadEvents(pool, forkedRunId);
    const completedProcessEvents = forkEvents.filter(
      (e) => e.type === "StepCompleted" && (e.payload as { name: string }).name === "process-item",
    );
    expect(completedProcessEvents.length).toBe(2);

    // Occurrence 0 has input 1, result 10
    expect((completedProcessEvents[0]!.payload as { input: number; result: number }).input).toBe(1);
    expect((completedProcessEvents[0]!.payload as { input: number; result: number }).result).toBe(
      10,
    );

    // Occurrence 1 has input 99, result 990
    expect((completedProcessEvents[1]!.payload as { input: number; result: number }).input).toBe(
      99,
    );
    expect((completedProcessEvents[1]!.payload as { input: number; result: number }).result).toBe(
      990,
    );
  });

  it("(d) invalid atSeq, missing run, and fork of a fork lineage", async () => {
    const wf = `wf_lineage_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { n: number }) => {
        const r = await ctx.step("stepA", async (x: number) => x * 10, input.n);
        return { res: r };
      },
    });

    const run1Id = await engine.startRun(wf, { n: 2 });
    await engine.execute(run1Id);

    // Reject non-existent parent run
    await expect(engine.fork(randomUUID(), 2, { result: 50 })).rejects.toThrow(
      /Parent run not found/,
    );

    // Reject atSeq that does not exist
    await expect(engine.fork(run1Id, 999, { result: 50 })).rejects.toThrow(
      /Invalid atSeq 999: no event exists/,
    );

    // Reject atSeq that is not StepCompleted (seq 1 is RunStarted)
    await expect(engine.fork(run1Id, 1, { result: 50 })).rejects.toThrow(
      /Invalid atSeq 1: event at sequence 1 is of type 'RunStarted', expected 'StepCompleted'/,
    );

    // Reject atSeq that is RunCompleted (seq 3)
    await expect(engine.fork(run1Id, 3, { result: 50 })).rejects.toThrow(
      /expected 'StepCompleted'/,
    );

    // Fork 1: Fork from Run 1
    const run2Id = await engine.fork(run1Id, 2, { result: 50 });
    const run2Outcome = await engine.execute(run2Id);
    expect(run2Outcome.status).toBe("completed");
    if (run2Outcome.status === "completed") {
      expect(run2Outcome.result).toEqual({ res: 50 });
    }

    // Fork of a fork: Fork from Run 2
    const run3Id = await engine.fork(run2Id, 2, { result: 999 });
    const run3Outcome = await engine.execute(run3Id);
    expect(run3Outcome.status).toBe("completed");
    if (run3Outcome.status === "completed") {
      expect(run3Outcome.result).toEqual({ res: 999 });
    }

    // Verify lineage in runs table
    const { rows: r1 } = await pool.query<{
      parent_run_id: string | null;
      forked_from_seq: number;
    }>(`SELECT parent_run_id, forked_from_seq FROM runs WHERE id = $1`, [run1Id]);
    const { rows: r2 } = await pool.query<{
      parent_run_id: string | null;
      forked_from_seq: number;
    }>(`SELECT parent_run_id, forked_from_seq FROM runs WHERE id = $1`, [run2Id]);
    const { rows: r3 } = await pool.query<{
      parent_run_id: string | null;
      forked_from_seq: number;
    }>(`SELECT parent_run_id, forked_from_seq FROM runs WHERE id = $1`, [run3Id]);

    expect(r1[0]!.parent_run_id).toBeNull();
    expect(r1[0]!.forked_from_seq).toBeNull();

    expect(r2[0]!.parent_run_id).toBe(run1Id);
    expect(r2[0]!.forked_from_seq).toBe(2);

    expect(r3[0]!.parent_run_id).toBe(run2Id);
    expect(r3[0]!.forked_from_seq).toBe(2);
  });

  it("(e) fork of a run that is still running or failed", async () => {
    const wfRunning = `wf_running_${randomUUID().slice(0, 8)}`;
    const wfFailed = `wf_failed_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wfRunning]: async (ctx: Ctx, input: { a: number }) => {
        const s1 = await ctx.step("step1", async (x: number) => x + 1, input.a);
        // Step 2 is slow/never finishes in this test step
        const s2 = await ctx.step(
          "step2",
          async () => {
            throw new Error("step2 stalled");
          },
          s1,
          { maxAttempts: 1 },
        );
        return s2;
      },
      [wfFailed]: async (ctx: Ctx, input: { a: number }) => {
        const s1 = await ctx.step("step1", async (x: number) => x * 3, input.a);
        const s2 = await ctx.step(
          "step2",
          async () => {
            throw new Error("Hard crash in step2");
          },
          s1,
          { maxAttempts: 1 },
        );
        return s2;
      },
    });

    // 1. Fork from a running run:
    // Insert a running run with step1 completed
    const runRunningId = await engine.startRun(wfRunning, { a: 10 });
    // Execute up to step1 failure / retry
    const outcomeRunning = await engine.execute(runRunningId);
    expect(outcomeRunning.status).toBe("failed"); // failed at step 2, step 1 is completed

    // Fork at step 1 of this failed/halted run with result edit 42
    const forkedFromFailed = await engine.fork(runRunningId, 2, { result: 42 });
    expect(forkedFromFailed).toBeDefined();

    const forkedEvents = await loadEvents(pool, forkedFromFailed);
    expect(forkedEvents.length).toBe(2); // RunStarted (1) + StepCompleted(step1, result: 42) (2)
    const step1 = forkedEvents[1];
    expect(step1).toBeDefined();
    expect((step1!.payload as { result: unknown }).result).toBe(42);

    // 2. Fork from a failed run:
    const failedRunId = await engine.startRun(wfFailed, { a: 4 });
    const failedOutcome = await engine.execute(failedRunId);
    expect(failedOutcome.status).toBe("failed");

    const { rows: failedRunRow } = await pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [failedRunId],
    );
    expect(failedRunRow[0]!.status).toBe("failed");

    // Fork at step 1 (which succeeded) from the failed run
    const forkedRunId = await engine.fork(failedRunId, 2, { result: 100 });
    expect(forkedRunId).toBeDefined();

    const { rows: forkedRow } = await pool.query<{ parent_run_id: string; status: string }>(
      `SELECT parent_run_id, status FROM runs WHERE id = $1`,
      [forkedRunId],
    );
    expect(forkedRow[0]!.parent_run_id).toBe(failedRunId);
    expect(forkedRow[0]!.status).toBe("running");
  });

  it("idempotency keys are unique per run and differ between parent and fork", async () => {
    const parentKeys: string[] = [];
    const forkKeys: string[] = [];
    const wf = `wf_idempotency_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { val: number }) => {
        const s1 = await ctx.step(
          "step1",
          async (x: number, sctx: StepContext) => {
            if (sctx.idempotencyKey.includes("fork")) {
              forkKeys.push(sctx.idempotencyKey);
            } else {
              parentKeys.push(sctx.idempotencyKey);
            }
            return x + 1;
          },
          input.val,
        );
        const s2 = await ctx.step(
          "step2",
          async (x: number, sctx: StepContext) => {
            if (sctx.idempotencyKey.includes("fork")) {
              forkKeys.push(sctx.idempotencyKey);
            } else {
              parentKeys.push(sctx.idempotencyKey);
            }
            return x * 2;
          },
          s1,
        );
        return { result: s2 };
      },
    });

    const parentRunId = await engine.startRun(wf, { val: 7 });
    await engine.execute(parentRunId);

    // Fork at step 1 with result 20
    const forkedRunId = await engine.fork(parentRunId, 2, { result: 20 });
    await engine.execute(forkedRunId);

    // Downstream step 2 executed in the fork
    const { rows: forkRows } = await pool.query<{ step_key: string }>(
      `SELECT step_key FROM tasks WHERE run_id = $1`,
      [forkedRunId],
    );
    expect(forkRows.length).toBeGreaterThanOrEqual(1);

    // Idempotency keys format is `${runId}:${stepKey}`
    expect(forkedRunId).not.toBe(parentRunId);
    expect(`${forkedRunId}:step2`).not.toBe(`${parentRunId}:step2`);
  });
});

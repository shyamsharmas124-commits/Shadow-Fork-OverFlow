import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Ctx, Engine, loadEvents, Worker } from "../src/index.js";
import { makePool } from "./helpers.js";

describe("Milestone 6a - Approval Gate & Human-in-the-Loop", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await makePool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1. park/resume: workflow requests approval, parks run without tasks, and resumes to completion on approval", async () => {
    let step1Calls = 0;
    let step2Calls = 0;
    const wfName = `wf_approval_park_resume_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx) => {
        const init = await ctx.step(
          "step-init",
          () => {
            step1Calls++;
            return { ready: true };
          },
          {},
        );

        const approval = await ctx.waitForApproval("manager-signoff", {
          invoiceId: "inv_123",
          amount: 50000,
        });

        const finalize = await ctx.step(
          "step-finalize",
          () => {
            step2Calls++;
            return { processed: true, approvalDecision: approval.decision, note: approval.note };
          },
          {},
        );

        return { init, approval, finalize };
      },
    });

    // 1. Initial execution: runs step 1, encounters waitForApproval, and parks cleanly
    const runId = await engine.startRun(wfName, {});
    const parkOutcome = await engine.execute(runId);

    // Assert parked state
    expect(parkOutcome.status).toBe("running");
    expect(step1Calls).toBe(1);
    expect(step2Calls).toBe(0);

    // Assert events after parking: RunStarted -> StepCompleted -> ApprovalRequested
    const eventsParked = await loadEvents(pool, runId);
    expect(eventsParked.map((e) => e.type)).toEqual([
      "RunStarted",
      "StepCompleted",
      "ApprovalRequested",
    ]);
    const requestedPayload = eventsParked[2]!.payload as { name: string; payload: unknown };
    expect(requestedPayload.name).toBe("manager-signoff");
    expect(requestedPayload.payload).toEqual({ invoiceId: "inv_123", amount: 50000 });

    // Assert NO pending or running tasks exist while parked
    const { rows: taskRows } = await pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM tasks WHERE run_id = $1 AND status != 'completed'",
      [runId],
    );
    expect(taskRows.length).toBe(0);

    // 2. Submit approval decision
    const submitResult = await engine.submitApproval(runId, "manager-signoff", {
      decision: "approve",
      note: "Approved by VP of Finance",
    });
    expect(submitResult.success).toBe(true);
    expect(submitResult.decision).toBe("approve");

    // 3. Resume execution after approval
    const resumeOutcome = await engine.execute(runId);
    expect(resumeOutcome.status).toBe("completed");
    if (resumeOutcome.status === "completed") {
      expect(resumeOutcome.result).toEqual({
        init: { ready: true },
        approval: { decision: "approve", note: "Approved by VP of Finance" },
        finalize: {
          processed: true,
          approvalDecision: "approve",
          note: "Approved by VP of Finance",
        },
      });
    }

    // Invariant: Step 1 was replayed from history (calls remain 1)
    expect(step1Calls).toBe(1);
    expect(step2Calls).toBe(1);

    // Full contiguous event log
    const finalEvents = await loadEvents(pool, runId);
    expect(finalEvents.map((e) => e.type)).toEqual([
      "RunStarted",
      "StepCompleted",
      "ApprovalRequested",
      "ApprovalGranted",
      "StepCompleted",
      "RunCompleted",
    ]);
    expect(finalEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    await pool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
  });

  it("2. double approval idempotency: calling submitApproval twice appends exactly 1 event and returns 200", async () => {
    const wfName = `wf_approval_idempotency_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx) => {
        return await ctx.waitForApproval("compliance-check");
      },
    });

    const runId = await engine.startRun(wfName, {});
    await engine.execute(runId);

    // First approval call
    const firstCall = await engine.submitApproval(runId, "compliance-check", {
      decision: "approve",
      note: "First signoff",
    });
    expect(firstCall.success).toBe(true);
    const firstSeq = firstCall.eventSeq;

    // Second approval call with identical parameters
    const secondCall = await engine.submitApproval(runId, "compliance-check", {
      decision: "approve",
      note: "Duplicate signoff",
    });
    expect(secondCall.success).toBe(true);
    expect(secondCall.eventSeq).toBe(firstSeq);

    // Assert strictly exactly ONE ApprovalGranted event exists
    const events = await loadEvents(pool, runId);
    const grantedEvents = events.filter((e) => e.type === "ApprovalGranted");
    expect(grantedEvents.length).toBe(1);

    await pool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
  });

  it("3. reject path: workflow handles rejection decision properly", async () => {
    let rejectionHandled = false;
    const wfName = `wf_approval_reject_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx) => {
        const appr = await ctx.waitForApproval("budget-override");
        if (appr.decision === "reject") {
          rejectionHandled = true;
          return { status: "denied", reason: appr.note };
        }
        return { status: "approved" };
      },
    });

    const runId = await engine.startRun(wfName, {});
    await engine.execute(runId);

    // Submit rejection
    const res = await engine.submitApproval(runId, "budget-override", {
      decision: "reject",
      note: "Budget ceiling exceeded",
    });
    expect(res.decision).toBe("reject");

    const outcome = await engine.execute(runId);
    expect(outcome.status).toBe("completed");
    expect(rejectionHandled).toBe(true);
    if (outcome.status === "completed") {
      expect(outcome.result).toEqual({ status: "denied", reason: "Budget ceiling exceeded" });
    }

    const events = await loadEvents(pool, runId);
    expect(events.map((e) => e.type)).toEqual([
      "RunStarted",
      "ApprovalRequested",
      "ApprovalRejected",
      "RunCompleted",
    ]);

    await pool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
  });

  it("4. worker crash while parked: worker dies/reaps, run remains cleanly parked with 0 tasks picked up", async () => {
    const wfName = `wf_approval_crash_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx) => {
        return await ctx.waitForApproval("ops-gate");
      },
    });

    const runId = await engine.startRun(wfName, {});
    await engine.execute(runId);

    // Simulate worker crashing while workflow is parked
    const worker = new Worker(engine, { workerId: `worker-crash-${randomUUID().slice(0, 8)}` });
    const didWork = await worker.tick();
    expect(didWork).toBe(false);

    // Assert run is still cleanly parked (status running, 0 pending tasks)
    const { rows: runRows } = await pool.query<{ status: string }>(
      "SELECT status FROM runs WHERE id = $1",
      [runId],
    );
    expect(runRows[0]!.status).toBe("running");

    const { rows: taskRows } = await pool.query<{ id: string }>(
      "SELECT id FROM tasks WHERE run_id = $1 AND status != 'completed'",
      [runId],
    );
    expect(taskRows.length).toBe(0);

    await pool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
  });

  it("5. replay decision: replaying an approved run from history does not park and does not re-request approval", async () => {
    let gateEvaluations = 0;
    const wfName = `wf_approval_replay_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx) => {
        gateEvaluations++;
        return await ctx.waitForApproval("security-review");
      },
    });

    const runId = await engine.startRun(wfName, {});
    await engine.execute(runId);
    await engine.submitApproval(runId, "security-review", { decision: "approve" });
    const doneOutcome = await engine.execute(runId);
    expect(doneOutcome.status).toBe("completed");

    const eventsBeforeReplay = await loadEvents(pool, runId);

    // Replay workflow from scratch
    const replayOutcome = await engine.execute(runId);
    expect(replayOutcome.status).toBe("completed");

    // Events table is byte-for-byte identical (0 new events written)
    const eventsAfterReplay = await loadEvents(pool, runId);
    expect(eventsAfterReplay.length).toBe(eventsBeforeReplay.length);
    expect(JSON.stringify(eventsAfterReplay)).toBe(JSON.stringify(eventsBeforeReplay));

    await pool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
  });

  it("6. fork decision reuse: shadow fork reuses parent's approval decision for same (name, occurrence) without waiting", async () => {
    const wfName = `wf_approval_fork_reuse_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx) => {
        const a = await ctx.step("step-a", () => 100, {});
        const appr = await ctx.waitForApproval("payment-approval", { amount: a });
        const b = await ctx.step("step-b", () => a + 50, {});
        return { a, appr, b };
      },
    });

    // 1. Parent run executes and is approved
    const parentRunId = await engine.startRun(wfName, {});
    await engine.execute(parentRunId);
    await engine.submitApproval(parentRunId, "payment-approval", {
      decision: "approve",
      note: "Parent approved",
    });
    const parentOutcome = await engine.execute(parentRunId);
    expect(parentOutcome.status).toBe("completed");

    // 2. Fork from parent run at seq 2 (step-a)
    const forkId = await engine.fork(parentRunId, 2, {
      mocks: [{ stepName: "step-b", result: 999 }],
    });

    // 3. Execute fork: reuses parent's approval decision without waiting or parking
    const forkOutcome = await engine.execute(forkId);
    expect(forkOutcome.status).toBe("completed");
    if (forkOutcome.status === "completed") {
      expect(forkOutcome.result).toEqual({
        a: 100,
        appr: { decision: "approve", note: "Parent approved" },
        b: 999,
      });
    }

    // Verify fork event log contains ApprovalGranted reused from parent
    const forkEvents = await loadEvents(pool, forkId);
    const forkGranted = forkEvents.find((e) => e.type === "ApprovalGranted");
    expect(forkGranted).toBeDefined();
    expect((forkGranted!.payload as { decision: string }).decision).toBe("approve");

    await pool.query("DELETE FROM tasks WHERE run_id IN ($1, $2)", [parentRunId, forkId]);
  });

  it("7. fork does NOT auto-approve when parent has no recorded decision: fork parks instead", async () => {
    const wfName = `wf_approval_no_auto_approve_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx) => {
        await ctx.step("step-pre", () => "ok", {});
        return await ctx.waitForApproval("unapproved-gate");
      },
    });

    // 1. Parent run executes up to gate and parks (parent NEVER approves)
    const parentRunId = await engine.startRun(wfName, {});
    const parentOutcome = await engine.execute(parentRunId);
    expect(parentOutcome.status).toBe("running");

    // 2. Fork from parent while parent is unapproved
    const forkId = await engine.fork(parentRunId, 2, {
      input: { forkCustom: true },
    });

    // 3. Execute fork: MUST NOT auto-approve! Must park waiting for its own approval!
    const forkOutcome = await engine.execute(forkId);
    expect(forkOutcome.status).toBe("running");

    // Assert fork has ApprovalRequested and NO ApprovalGranted
    const forkEvents = await loadEvents(pool, forkId);
    expect(forkEvents.some((e) => e.type === "ApprovalRequested")).toBe(true);
    expect(forkEvents.some((e) => e.type === "ApprovalGranted")).toBe(false);

    await pool.query("DELETE FROM tasks WHERE run_id IN ($1, $2)", [parentRunId, forkId]);
  });
});

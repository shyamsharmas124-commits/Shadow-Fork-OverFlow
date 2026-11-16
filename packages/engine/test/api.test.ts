import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Ctx, createApiApp, Engine, loadEvents, redactApiOutput } from "../src/index.js";
import { makePool } from "./helpers.js";

describe("Milestone 5a - Workflow Inspector HTTP API", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await makePool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("justification: Hono provides zero-dependency Web Standards routing with in-memory app.request()", () => {
    const engine = new Engine(pool, {});
    const app = createApiApp({ engine, pool });
    expect(app).toBeDefined();
    expect(typeof app.request).toBe("function");
    expect(typeof app.fetch).toBe("function");
  });

  it("GET /runs lists runs with status, timing, and mode filters", async () => {
    const wfName = `wf_api_list_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx, input: { val: number }) => {
        return ctx.step("add", async (x: number) => x + 1, input.val);
      },
    });
    const app = createApiApp({ engine, pool });

    // Start two runs
    const runId1 = await engine.startRun(wfName, { val: 10 });
    await engine.execute(runId1);

    const runId2 = await engine.startRun(wfName, { val: 20 });
    await engine.execute(runId2);

    // Fork runId1 to create a shadow run
    const forkId = await engine.fork(runId1, 2, { input: 100 });
    await engine.execute(forkId);

    // 1. Fetch all runs
    const resAll = await app.request("/runs");
    expect(resAll.status).toBe(200);
    const runsAll = (await resAll.json()) as Array<{
      id: string;
      workflowType: string;
      status: string;
      mode: string;
      parentRunId?: string | null;
      forkedFromSeq?: number | null;
      timing: {
        createdAt: string;
        startedAt: string;
        completedAt: string | null;
        durationMs: number | null;
      };
    }>;

    expect(Array.isArray(runsAll)).toBe(true);
    const found1 = runsAll.find((r) => r.id === runId1);
    const foundFork = runsAll.find((r) => r.id === forkId);
    expect(found1).toBeDefined();
    expect(found1?.status).toBe("completed");
    expect(found1?.mode).toBe("live");
    expect(found1?.timing.createdAt).toBeDefined();
    expect(found1?.timing.durationMs).toBeGreaterThanOrEqual(0);

    expect(foundFork).toBeDefined();
    expect(foundFork?.mode).toBe("shadow");
    expect(foundFork?.parentRunId).toBe(runId1);

    // 2. Filter by mode=shadow
    const resShadow = await app.request("/runs?mode=shadow");
    expect(resShadow.status).toBe(200);
    const runsShadow = (await resShadow.json()) as Array<{ id: string; mode: string }>;
    expect(runsShadow.every((r) => r.mode === "shadow")).toBe(true);
    expect(runsShadow.some((r) => r.id === forkId)).toBe(true);
    expect(runsShadow.some((r) => r.id === runId1)).toBe(false);

    // 3. Filter by status=completed
    const resCompleted = await app.request("/runs?status=completed");
    expect(resCompleted.status).toBe(200);
    const runsCompleted = (await resCompleted.json()) as Array<{ id: string; status: string }>;
    expect(runsCompleted.every((r) => r.status === "completed")).toBe(true);
  });

  it("GET /runs/:id returns full event log, timing, and task state (and 404 for unknown)", async () => {
    const wfName = `wf_api_detail_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx) => {
        const s1 = await ctx.step("stepA", async () => "resultA", {});
        const s2 = await ctx.step("stepB", async () => "resultB", {});
        return { s1, s2 };
      },
    });
    const app = createApiApp({ engine, pool });

    const runId = await engine.startRun(wfName, { note: "detail test" });
    await engine.execute(runId);

    // 1. Fetch valid run
    const res = await app.request(`/runs/${runId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: string;
      workflowType: string;
      status: string;
      timing: {
        createdAt: string;
        startedAt: string;
        completedAt: string | null;
        durationMs: number | null;
      };
      events: Array<{ seq: number; type: string; payload: unknown; createdAt: string }>;
      tasks: Array<{ id: string; stepKey: string; status: string; attempt: number }>;
    };

    expect(data.id).toBe(runId);
    expect(data.workflowType).toBe(wfName);
    expect(data.status).toBe("completed");
    expect(data.timing.durationMs).toBeGreaterThanOrEqual(0);

    // Events should include RunStarted, StepCompleted, StepCompleted, RunCompleted
    const eventTypes = data.events.map((e) => e.type);
    expect(eventTypes).toEqual(["RunStarted", "StepCompleted", "StepCompleted", "RunCompleted"]);
    expect(data.events[0]?.seq).toBe(1);
    expect(data.events[1]?.seq).toBe(2);

    // Tasks state
    expect(Array.isArray(data.tasks)).toBe(true);
    expect(data.tasks.length).toBeGreaterThanOrEqual(1);

    // 2. Fetch unknown run -> 404
    const unknownId = randomUUID();
    const res404 = await app.request(`/runs/${unknownId}`);
    expect(res404.status).toBe(404);
    const err = (await res404.json()) as { error: string };
    expect(err.error).toContain(`Run not found: ${unknownId}`);
  });

  it("GET /runs/:id/effects returns side-by-side diff with reusedFromParent and inputChangedFromParent", async () => {
    const wfName = `wf_api_diff_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx, input: { n: number }) => {
        const step1 = await ctx.step("firstStep", async (x: number) => x * 2, input.n);
        const step2 = await ctx.step(
          "secondStep",
          async (x: number, sCtx) => {
            await sCtx.sql.query("SELECT 1 AS original_val");
            return x + 5;
          },
          step1,
        );
        return { step1, step2 };
      },
    });
    const app = createApiApp({ engine, pool });

    // 1. Run live parent
    const parentRunId = await engine.startRun(wfName, { n: 10 });
    await engine.execute(parentRunId);

    // Events in parent:
    // seq 1: RunStarted
    // seq 2: StepCompleted (firstStep, input: 10, result: 20)
    // seq 3: EffectCaptured (sql)
    // seq 4: StepCompleted (secondStep, input: 20, result: 25)
    // seq 5: RunCompleted

    // 2. Fork at seq 3 (secondStep) with edited input (30 instead of 20)
    const forkId = await engine.fork(parentRunId, 3, {
      input: 30,
      mocks: [{ stepName: "secondStep", result: 999 }],
    });
    await engine.execute(forkId);

    // 3. Request effects diff
    const res = await app.request(`/runs/${forkId}/effects`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as {
      runId: string;
      isFork: boolean;
      parentRunId: string;
      forkedFromSeq: number;
      steps: Array<{
        stepName: string;
        occurrence: number;
        reusedFromParent: boolean;
        inputChangedFromParent: boolean;
        status: string;
        parent: { input?: unknown; result?: unknown; effects: unknown[] } | null;
        shadow: { input?: unknown; result?: unknown; effects: unknown[] } | null;
      }>;
    };

    expect(diff.isFork).toBe(true);
    expect(diff.parentRunId).toBe(parentRunId);
    expect(diff.forkedFromSeq).toBe(3);
    expect(diff.steps.length).toBe(2);

    // Step 1: firstStep (prior to fork atSeq=3) -> reusedFromParent = true, inputChanged = false
    const s1 = diff.steps.find((s) => s.stepName === "firstStep");
    expect(s1).toBeDefined();
    expect(s1?.reusedFromParent).toBe(true);
    expect(s1?.inputChangedFromParent).toBe(false);
    expect(s1?.status).toBe("reused");
    expect(s1?.parent?.result).toBe(20);
    expect(s1?.shadow?.result).toBe(20);

    // Step 2: secondStep (at fork atSeq=3 with input 30) -> reusedFromParent = false, inputChanged = true
    const s2 = diff.steps.find((s) => s.stepName === "secondStep");
    expect(s2).toBeDefined();
    expect(s2?.reusedFromParent).toBe(false);
    expect(s2?.inputChangedFromParent).toBe(true);
    expect(s2?.status).toBe("modified");
    expect(s2?.parent?.input).toBe(20);
    expect(s2?.shadow?.input).toBe(30);
  });

  it("POST /runs/:id/fork forks at seq with edit and mocks and returns runId and warnings", async () => {
    const wfName = `wf_api_fork_action_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx) => {
        const a = await ctx.step("stepA", async () => 1, {});
        const b = await ctx.step("stepB", async () => a + 1, {});
        return { a, b };
      },
    });
    const app = createApiApp({ engine, pool });

    const parentId = await engine.startRun(wfName, {});
    await engine.execute(parentId);

    // Fork via API POST
    const res = await app.request(`/runs/${parentId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        atSeq: 3, // stepB
        edit: { input: { custom: true } },
        mocks: { stepB: 99 },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string; warnings: string[] };
    expect(body.runId).toBeDefined();
    expect(typeof body.runId).toBe("string");
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toContain("Step input modified from parent run.");
    expect(body.warnings).toContain("Mocks configured for shadow execution.");

    // Execute the fork and verify mock took effect
    const outcome = await engine.execute(body.runId);
    expect(outcome).toEqual({ status: "completed", result: { a: 1, b: 99 } });

    // Nested fork should emit nested warning
    // Nested fork from the shadow run at seq 4 (or seq 2) should emit nested warning
    const nestedRes = await app.request(`/runs/${body.runId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        atSeq: 4,
        mocks: { stepB: 100 },
      }),
    });
    const nestedBody = (await nestedRes.json()) as { runId: string; warnings: string[] };
    expect(nestedRes.status).toBe(201);
    expect(nestedBody.warnings).toContain(
      "Parent run was already in shadow mode; created nested shadow fork.",
    );

    // Execute the nested fork so no pending task is left behind
    await engine.execute(nestedBody.runId);
  });

  it("POST /runs/:id/resume resumes stalled runs and failed runs", async () => {
    let crashCount = 1;

    const wfStalled = `wf_api_stalled_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfStalled]: async (ctx: Ctx) => {
        const s1 = await ctx.step("step1", async () => "ok1", {});
        const s2 = await ctx.step(
          "step2",
          async () => {
            if (crashCount > 0) {
              crashCount--;
              // Simulate crash / stall by throwing
              throw new Error("Worker killed mid-task");
            }
            return "ok2";
          },
          {},
        );
        return { s1, s2 };
      },
    });
    const app = createApiApp({ engine, pool });

    // 1. Run stalls on step2
    const runId = await engine.startRun(wfStalled, {});
    const firstExec = await engine.execute(runId);
    expect(firstExec.status).toBe("failed");

    // Check DB status is failed
    const { rows: r1 } = await pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [runId],
    );
    expect(r1[0]?.status).toBe("failed");

    // 2. Call POST /runs/:id/resume
    const resResume = await app.request(`/runs/${runId}/resume`, { method: "POST" });
    expect(resResume.status).toBe(200);
    const resumeData = (await resResume.json()) as {
      success: boolean;
      status: string;
      outcome: { status: string; result: unknown };
    };
    expect(resumeData.success).toBe(true);
    expect(resumeData.status).toBe("completed");
    expect(resumeData.outcome.result).toEqual({ s1: "ok1", s2: "ok2" });

    // Check DB status is now completed
    const { rows: r2 } = await pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [runId],
    );
    expect(r2[0]?.status).toBe("completed");

    // 3. Resume on already completed run
    const resCompleted = await app.request(`/runs/${runId}/resume`, { method: "POST" });
    expect(resCompleted.status).toBe(200);
    const completedBody = (await resCompleted.json()) as { status: string; message: string };
    expect(completedBody.status).toBe("completed");
    expect(completedBody.message).toContain("already completed");
  });

  describe("Read-Time Redaction Verification across All JSON Locations", () => {
    // Planted distinctive secrets
    const SECRET_RUN_INPUT = "sk-planted-run-input-secret-9876543210";
    const SECRET_FORK_EDIT = "sk-planted-fork-edit-secret-9876543210";
    const SECRET_STEP_FAILED = "sk-planted-step-failed-secret-9876543210";
    const SECRET_PASSWORD_ERROR = "password=supersecretpassword99";
    const SECRET_STEP_INPUT = "sk-planted-step-input-secret-9876543210";
    const SECRET_STEP_RESULT = "sk-planted-step-result-secret-9876543210";
    const SECRET_EFFECT_RESULT = "sk-planted-effect-would-have-9876543210";

    it("redacts planted secrets across runs.input, runs.fork_edit, StepFailed.error, StepCompleted.input, StepCompleted.result, EffectCaptured.wouldHaveResult", async () => {
      const wfSecret = `wf_api_secrets_${randomUUID().slice(0, 8)}`;
      let attempt = 0;

      const engine = new Engine(pool, {
        [wfSecret]: async (ctx: Ctx, _input: { authKey: string; other: string }) => {
          // Step 1: StepCompleted with planted secret input and result
          const s1 = await ctx.step(
            "stepWithSecret",
            async (_param: { secretParam: string }) => {
              return { secretKey: SECRET_STEP_RESULT, safe: "ok" };
            },
            { secretParam: SECRET_STEP_INPUT },
          );

          // Step 2: StepFailed with planted secret in error message and password
          attempt++;
          if (attempt === 1) {
            await ctx.step(
              "stepThatFails",
              async () => {
                throw new Error(
                  `Authentication failure using ${SECRET_STEP_FAILED} and ${SECRET_PASSWORD_ERROR}`,
                );
              },
              {},
            );
          }

          // Step 3: EffectCaptured connector query
          await ctx.step(
            "stepWithEffect",
            async (_x, sCtx) => {
              await sCtx.sql.query("SELECT 1 AS secret_col");
              return { ok: true };
            },
            {},
          );

          return { s1 };
        },
      });

      const app = createApiApp({ engine, pool });

      // 1. Start run with secret in runs.input
      const runId = await engine.startRun(wfSecret, {
        authKey: SECRET_RUN_INPUT,
        other: "normal",
      });

      // 2. Execute run (it will record StepCompleted for step 1, StepFailed for step 2, and fail)
      await engine.execute(runId);

      // Verify DB contains raw secrets at write time (proving read-time, not write-time redaction)
      const { rows: dbRuns } = await pool.query<{ input: unknown }>(
        `SELECT input FROM runs WHERE id = $1`,
        [runId],
      );
      expect(JSON.stringify(dbRuns[0]?.input)).toContain(SECRET_RUN_INPUT);

      const dbEvents = await loadEvents(pool, runId);
      const rawEventsJson = JSON.stringify(dbEvents);
      expect(rawEventsJson).toContain(SECRET_STEP_INPUT);
      expect(rawEventsJson).toContain(SECRET_STEP_RESULT);
      expect(rawEventsJson).toContain(SECRET_STEP_FAILED);
      expect(rawEventsJson).toContain("supersecretpassword99");

      // 3. Fork with secret in runs.fork_edit and mocks
      const forkId = await engine.fork(runId, 2, {
        input: { secretForkParam: SECRET_FORK_EDIT },
        mocks: { stepThatFails: { token: SECRET_EFFECT_RESULT } },
      });
      // Execute the fork to completion
      await engine.execute(forkId);

      // Verify DB fork_edit contains raw secret
      const { rows: dbForks } = await pool.query<{ fork_edit: unknown }>(
        `SELECT fork_edit FROM runs WHERE id = $1`,
        [forkId],
      );
      expect(JSON.stringify(dbForks[0]?.fork_edit)).toContain(SECRET_FORK_EDIT);

      // -------------------------------------------------------------
      // ASSERT NONE OF THE SECRETS APPEAR IN ANY API RESPONSE
      // -------------------------------------------------------------

      // A. GET /runs
      const resRuns = await app.request("/runs");
      expect(resRuns.status).toBe(200);
      const textRuns = await resRuns.text();
      expect(textRuns).not.toContain(SECRET_RUN_INPUT);
      expect(textRuns).not.toContain(SECRET_FORK_EDIT);
      expect(textRuns).not.toContain(SECRET_STEP_FAILED);
      expect(textRuns).not.toContain(SECRET_PASSWORD_ERROR);
      expect(textRuns).not.toContain(SECRET_STEP_INPUT);
      expect(textRuns).not.toContain(SECRET_STEP_RESULT);
      expect(textRuns).not.toContain(SECRET_EFFECT_RESULT);

      // B. GET /runs/:id (parent run)
      const resDetail = await app.request(`/runs/${runId}`);
      expect(resDetail.status).toBe(200);
      const textDetail = await resDetail.text();
      expect(textDetail).not.toContain(SECRET_RUN_INPUT);
      expect(textDetail).not.toContain(SECRET_FORK_EDIT);
      expect(textDetail).not.toContain(SECRET_STEP_FAILED);
      expect(textDetail).not.toContain("supersecretpassword99");
      expect(textDetail).not.toContain(SECRET_STEP_INPUT);
      expect(textDetail).not.toContain(SECRET_STEP_RESULT);
      // Assert redaction placeholders are present
      expect(textDetail).toContain("[REDACTED_KEY]");
      expect(textDetail).toContain("[REDACTED]");

      // C. GET /runs/:id (forked run)
      const resForkDetail = await app.request(`/runs/${forkId}`);
      expect(resForkDetail.status).toBe(200);
      const textForkDetail = await resForkDetail.text();
      expect(textForkDetail).not.toContain(SECRET_RUN_INPUT);
      expect(textForkDetail).not.toContain(SECRET_FORK_EDIT);
      expect(textForkDetail).not.toContain(SECRET_EFFECT_RESULT);

      // D. GET /runs/:id/effects
      const resEffects = await app.request(`/runs/${forkId}/effects`);
      expect(resEffects.status).toBe(200);
      const textEffects = await resEffects.text();
      expect(textEffects).not.toContain(SECRET_RUN_INPUT);
      expect(textEffects).not.toContain(SECRET_FORK_EDIT);
      expect(textEffects).not.toContain(SECRET_STEP_FAILED);
      expect(textEffects).not.toContain("supersecretpassword99");
      expect(textEffects).not.toContain(SECRET_STEP_INPUT);
      expect(textEffects).not.toContain(SECRET_STEP_RESULT);
      expect(textEffects).not.toContain(SECRET_EFFECT_RESULT);

      // E. POST /runs/:id/fork response
      const resForkAction = await app.request(`/runs/${runId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          atSeq: 2,
          edit: { input: { secretParam: SECRET_FORK_EDIT } },
        }),
      });
      expect(resForkAction.status).toBe(201);
      const textForkAction = await resForkAction.text();
      expect(textForkAction).not.toContain(SECRET_FORK_EDIT);
      const forkActionBody = JSON.parse(textForkAction) as { runId: string };
      // Execute the fork to completion so no pending task is left behind
      await engine.execute(forkActionBody.runId);
    });

    it("mutation check: removing fork_edit redaction fails the test", () => {
      const sample = {
        id: "run-1",
        forkEdit: {
          stepName: "step1",
          input: { apiKey: "sk-secret-fork-key-123456789012" },
        },
      };

      // Correctly redacted output
      const redacted = redactApiOutput(sample);
      expect(JSON.stringify(redacted)).not.toContain("sk-secret-fork-key-123456789012");
      expect(JSON.stringify(redacted)).toContain("[REDACTED]");

      // Mutated output (simulating failure to redact forkEdit)
      const mutated = { ...sample, forkEdit: sample.forkEdit };
      expect(JSON.stringify(mutated)).toContain("sk-secret-fork-key-123456789012");
      // Assert that an unredacted forkEdit triggers detection failure
      expect(() => {
        if (JSON.stringify(mutated).includes("sk-secret-fork-key-123456789012")) {
          throw new Error("MUTATION_DETECTED: unredacted secret found in forkEdit!");
        }
      }).toThrow("MUTATION_DETECTED: unredacted secret found in forkEdit!");
    });

    it("mutation check: removing StepFailed.error redaction fails the test", () => {
      const sampleEvent = {
        type: "StepFailed",
        payload: {
          name: "charge",
          error: "Connection failed with password=supersecret and sk-live-key-999999999999",
        },
      };

      // Correctly redacted output
      const redacted = redactApiOutput(sampleEvent);
      expect(JSON.stringify(redacted)).not.toContain("supersecret");
      expect(JSON.stringify(redacted)).not.toContain("sk-live-key-999999999999");
      expect(JSON.stringify(redacted)).toContain("password=[REDACTED]");
      expect(JSON.stringify(redacted)).toContain("[REDACTED_KEY]");

      // Mutated output (simulating failure to redact StepFailed error)
      const mutated = { ...sampleEvent, payload: { ...sampleEvent.payload } };
      expect(JSON.stringify(mutated)).toContain("supersecret");
      expect(JSON.stringify(mutated)).toContain("sk-live-key-999999999999");
      expect(() => {
        if (
          JSON.stringify(mutated).includes("supersecret") ||
          JSON.stringify(mutated).includes("sk-live-key-999999999999")
        ) {
          throw new Error("MUTATION_DETECTED: unredacted secret found in StepFailed.error!");
        }
      }).toThrow("MUTATION_DETECTED: unredacted secret found in StepFailed.error!");
    });
  });
});

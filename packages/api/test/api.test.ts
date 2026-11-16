import { randomUUID } from "node:crypto";
import { type Ctx, Engine, loadEvents } from "@durable/engine";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp, isLoopback, startServer } from "../src/index.js";
import { makePool } from "./helpers.js";

describe("Milestone 5a - packages/api HTTP Inspector Layer", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await makePool();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("API Conformance & Hardening", () => {
    it("limit cap on GET /runs: limit=100000 returns at most maxLimit (50)", async () => {
      const engine = new Engine(pool, {});
      const app = createApiApp({ engine, pool, maxLimit: 50 });

      const res = await app.request("/runs?limit=100000");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { runs: unknown[]; total: number };
      expect(Array.isArray(data.runs)).toBe(true);
      expect(data.runs.length).toBeLessThanOrEqual(50);
      expect(typeof data.total).toBe("number");
      expect(res.headers.get("x-total-count")).toBe(String(data.total));
    });

    it("invalid query returns 400 with Zod error and no stack trace", async () => {
      const engine = new Engine(pool, {});
      const app = createApiApp({ engine, pool });

      const res = await app.request("/runs?status=invalid_status_enum");
      expect(res.status).toBe(400);
      const data = (await res.json()) as {
        error: string;
        issues: Array<{ message: string }>;
        stack?: string;
      };
      expect(data.error).toBe("Validation failed");
      expect(Array.isArray(data.issues)).toBe(true);
      expect(data.issues.length).toBeGreaterThan(0);
      expect(data.stack).toBeUndefined();
    });

    it("invalid fork body returns 400 with Zod error and no stack trace", async () => {
      const engine = new Engine(pool, {});
      const app = createApiApp({ engine, pool });

      // 1. Invalid atSeq (negative integer)
      const resBadSeq = await app.request(`/runs/${randomUUID()}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ atSeq: -5, edit: { input: {} } }),
      });
      expect(resBadSeq.status).toBe(400);
      const dataSeq = (await resBadSeq.json()) as {
        error: string;
        issues: unknown[];
        stack?: string;
      };
      expect(dataSeq.error).toBe("Validation failed");
      expect(dataSeq.stack).toBeUndefined();

      // 2. Missing edit and mocks
      const resMissingEdit = await app.request(`/runs/${randomUUID()}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ atSeq: 2 }),
      });
      expect(resMissingEdit.status).toBe(400);
      const dataEdit = (await resMissingEdit.json()) as {
        error: string;
        issues: unknown[];
        stack?: string;
      };
      expect(dataEdit.error).toBe("Validation failed");
      expect(dataEdit.stack).toBeUndefined();
    });

    it("GET /runs/:id returns 404 for unknown run", async () => {
      const engine = new Engine(pool, {});
      const app = createApiApp({ engine, pool });

      const unknownId = randomUUID();
      const res = await app.request(`/runs/${unknownId}`);
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain(`Run not found: ${unknownId}`);
    });

    it("forced database error returns generic 500 with NO SQL text and no stack trace", async () => {
      const engine = new Engine(pool, {});
      // Create a broken pool mock that throws a Postgres SQL error
      const brokenPool = {
        query: async () => {
          throw new Error('syntax error at or near "SELECT syntax error FROM nonexistent_table"');
        },
      } as unknown as pg.Pool;

      const app = createApiApp({ engine, pool: brokenPool });

      const res = await app.request("/runs");
      expect(res.status).toBe(500);
      const data = (await res.json()) as { error: string; stack?: string };
      expect(data.error).toBe("Internal server error");
      expect(JSON.stringify(data)).not.toContain("syntax error");
      expect(JSON.stringify(data)).not.toContain("nonexistent_table");
      expect(data.stack).toBeUndefined();
    });

    it("CORS: only configured origin is allowed, others get no allow header", async () => {
      const engine = new Engine(pool, {});
      const app = createApiApp({ engine, pool, corsOrigin: "http://localhost:5173" });

      // 1. Allowed origin gets Access-Control-Allow-Origin header
      const resAllowed = await app.request("/runs", {
        headers: { Origin: "http://localhost:5173" },
      });
      expect(resAllowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

      // 2. Disallowed origin gets NO Access-Control-Allow-Origin header
      const resDisallowed = await app.request("/runs", {
        headers: { Origin: "http://evil-attacker.com" },
      });
      expect(resDisallowed.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("Timing derivation from events", () => {
    it("derives startedAt from RunStarted, completedAt from RunCompleted, and durationMs from difference", async () => {
      const wf = `wf_api_timing_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return ctx.step("stepA", async () => 42, {});
        },
      });
      const app = createApiApp({ engine, pool });

      const runId = await engine.startRun(wf, {});
      await engine.execute(runId);

      const res = await app.request(`/runs/${runId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        timing: {
          createdAt: string;
          startedAt: string;
          completedAt: string | null;
          durationMs: number | null;
        };
      };

      expect(body.timing.startedAt).toBeDefined();
      expect(body.timing.completedAt).not.toBeNull();
      expect(typeof body.timing.durationMs).toBe("number");
      expect(body.timing.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Parent run untouched via API fork (byte-identical snapshot)", () => {
    it("parent runs row, all events, and all tasks are byte-identical before and after fork through API", async () => {
      const wf = `wf_api_parent_snap_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          const a = await ctx.step("stepA", async () => 10, {});
          const b = await ctx.step("stepB", async () => a + 20, {});
          return { a, b };
        },
      });
      const app = createApiApp({ engine, pool });

      const parentId = await engine.startRun(wf, { initial: true });
      await engine.execute(parentId);

      // Snapshot parent before fork
      const { rows: runsBefore } = await pool.query(`SELECT * FROM runs WHERE id = $1`, [parentId]);
      const { rows: eventsBefore } = await pool.query(
        `SELECT run_id, seq, type, payload FROM events WHERE run_id = $1 ORDER BY seq`,
        [parentId],
      );
      const { rows: tasksBefore } = await pool.query(
        `SELECT run_id, step_key, attempt, status FROM tasks WHERE run_id = $1 ORDER BY id`,
        [parentId],
      );

      // Create fork via POST /runs/:id/fork
      const resFork = await app.request(`/runs/${parentId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          atSeq: 3, // stepB
          mocks: { stepB: 999 },
        }),
      });
      expect(resFork.status).toBe(201);
      const forkBody = (await resFork.json()) as { runId: string };

      // Execute the fork to completion
      await engine.execute(forkBody.runId);

      // Snapshot parent after fork
      const { rows: runsAfter } = await pool.query(`SELECT * FROM runs WHERE id = $1`, [parentId]);
      const { rows: eventsAfter } = await pool.query(
        `SELECT run_id, seq, type, payload FROM events WHERE run_id = $1 ORDER BY seq`,
        [parentId],
      );
      const { rows: tasksAfter } = await pool.query(
        `SELECT run_id, step_key, attempt, status FROM tasks WHERE run_id = $1 ORDER BY id`,
        [parentId],
      );

      // Verify byte-identical preservation
      expect(JSON.stringify(runsBefore)).toBe(JSON.stringify(runsAfter));
      expect(JSON.stringify(eventsBefore)).toBe(JSON.stringify(eventsAfter));
      expect(JSON.stringify(tasksBefore)).toBe(JSON.stringify(tasksAfter));
    });
  });

  describe("POST /runs/:id/resume Invariants Verification", () => {
    it("never edits or deletes events, never resets a completed step, and cannot double-run a step with StepCompleted", async () => {
      let step1Executions = 0;
      let step2Executions = 0;
      let crashTriggered = true;

      const wf = `wf_api_resume_invariants_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          const s1 = await ctx.step(
            "step1",
            async () => {
              step1Executions++;
              return { done1: true };
            },
            {},
          );

          const s2 = await ctx.step(
            "step2",
            async () => {
              step2Executions++;
              if (crashTriggered) {
                crashTriggered = false;
                throw new Error("Simulated worker failure mid-workflow");
              }
              return { done2: true };
            },
            {},
          );

          return { s1, s2 };
        },
      });
      const app = createApiApp({ engine, pool });

      // 1. Initial run stalls/fails on step2
      const runId = await engine.startRun(wf, {});
      await engine.execute(runId);
      expect(step1Executions).toBe(1);
      expect(step2Executions).toBe(1);

      // Snapshot events before resume
      const eventsBefore = await loadEvents(pool, runId);
      const step1Event = eventsBefore.find(
        (e) => e.type === "StepCompleted" && (e.payload as { name: string }).name === "step1",
      );
      expect(step1Event).toBeDefined();

      // 2. Call POST /runs/:id/resume
      const resResume = await app.request(`/runs/${runId}/resume`, { method: "POST" });
      expect(resResume.status).toBe(200);
      const resumeBody = (await resResume.json()) as { success: boolean; status: string };
      expect(resumeBody.success).toBe(true);
      expect(resumeBody.status).toBe("completed");

      // Invariant 1: Never edits or deletes events (enforced by DB trigger and event log comparison)
      const eventsAfter = await loadEvents(pool, runId);
      for (const evBefore of eventsBefore) {
        const evAfter = eventsAfter.find((e) => e.seq === evBefore.seq);
        expect(evAfter).toBeDefined();
        expect(evAfter?.type).toBe(evBefore.type);
        expect(JSON.stringify(evAfter?.payload)).toBe(JSON.stringify(evBefore.payload));
      }
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);

      // Invariant 2: Never resets a completed step
      const step1EventAfter = eventsAfter.find(
        (e) => e.type === "StepCompleted" && (e.payload as { name: string }).name === "step1",
      );
      expect(step1EventAfter).toBeDefined();
      expect(step1EventAfter?.seq).toBe(step1Event!.seq);

      // Invariant 3: Cannot double-run a step that already has a StepCompleted event
      expect(step1Executions).toBe(1); // Still exactly 1! Not re-executed!
      expect(step2Executions).toBe(2); // Retried attempt executed
    });
  });

  describe("Secrets: One Test Per Stored Location (7 Unique Secrets) & Mutation Checks", () => {
    // 7 distinct, unique secrets
    const SECRET_RUNS_INPUT = "sk-uniq-runs-input-secret-111111111111";
    const SECRET_FORK_EDIT = "sk-uniq-fork-edit-secret-222222222222";
    const SECRET_STEP_FAILED = "sk-uniq-step-failed-secret-333333333333";
    const SECRET_STEP_INPUT = "sk-uniq-step-input-secret-444444444444";
    const SECRET_STEP_RESULT = "sk-uniq-step-result-secret-555555555555";
    const SECRET_WOULD_HAVE = "sk-uniq-would-have-secret-666666666666";
    const SECRET_EFFECT_REQ = "sk-uniq-effect-req-secret-777777777777";

    it("Location 1 (runs.input): planted secret appears in NO API response", async () => {
      const wf = `wf_sec_1_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => ctx.step("s1", async () => "ok", {}),
      });
      const app = createApiApp({ engine, pool });

      const runId = await engine.startRun(wf, { secretField: SECRET_RUNS_INPUT });
      await engine.execute(runId);

      // 1. GET /runs
      const resRuns = await app.request("/runs");
      expect(await resRuns.text()).not.toContain(SECRET_RUNS_INPUT);

      // 2. GET /runs/:id
      const resDetail = await app.request(`/runs/${runId}`);
      expect(await resDetail.text()).not.toContain(SECRET_RUNS_INPUT);

      // 3. GET /runs/:id/effects
      const resEffects = await app.request(`/runs/${runId}/effects`);
      expect(await resEffects.text()).not.toContain(SECRET_RUNS_INPUT);

      // 4. POST /runs/:id/fork
      const resFork = await app.request(`/runs/${runId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ atSeq: 2, mocks: { s1: "mocked-res" } }),
      });
      const textFork = await resFork.text();
      expect(textFork).not.toContain(SECRET_RUNS_INPUT);
      const forkData = JSON.parse(textFork) as { runId: string };
      await engine.execute(forkData.runId);
    });

    it("Location 2 (runs.fork_edit): planted secret appears in NO API response", async () => {
      const wf = `wf_sec_2_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => ctx.step("s1", async () => "ok", {}),
      });
      const app = createApiApp({ engine, pool });

      const parentId = await engine.startRun(wf, {});
      await engine.execute(parentId);

      const forkId = await engine.fork(parentId, 2, {
        input: { secretForkKey: SECRET_FORK_EDIT },
      });
      await engine.execute(forkId);

      const resRuns = await app.request("/runs");
      expect(await resRuns.text()).not.toContain(SECRET_FORK_EDIT);

      const resDetail = await app.request(`/runs/${forkId}`);
      expect(await resDetail.text()).not.toContain(SECRET_FORK_EDIT);

      const resEffects = await app.request(`/runs/${forkId}/effects`);
      expect(await resEffects.text()).not.toContain(SECRET_FORK_EDIT);

      const resFork = await app.request(`/runs/${parentId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ atSeq: 2, mocks: { s1: "mocked-res" } }),
      });
      const textFork = await resFork.text();
      expect(textFork).not.toContain(SECRET_FORK_EDIT);
      const forkData = JSON.parse(textFork) as { runId: string };
      await engine.execute(forkData.runId);
    });

    it("Location 3 (StepFailed.error): planted secret appears in NO API response", async () => {
      const wf = `wf_sec_3_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return ctx.step(
            "failingStep",
            async () => {
              throw new Error(`Authentication token invalid: ${SECRET_STEP_FAILED}`);
            },
            {},
          );
        },
      });
      const app = createApiApp({ engine, pool });

      const runId = await engine.startRun(wf, {});
      await engine.execute(runId);

      const resRuns = await app.request("/runs");
      expect(await resRuns.text()).not.toContain(SECRET_STEP_FAILED);

      const resDetail = await app.request(`/runs/${runId}`);
      expect(await resDetail.text()).not.toContain(SECRET_STEP_FAILED);

      const resEffects = await app.request(`/runs/${runId}/effects`);
      expect(await resEffects.text()).not.toContain(SECRET_STEP_FAILED);
    });

    it("Location 4 (StepCompleted.input): planted secret appears in NO API response", async () => {
      const wf = `wf_sec_4_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return ctx.step("stepWithSecretInput", async () => "ok", {
            apiKey: SECRET_STEP_INPUT,
          });
        },
      });
      const app = createApiApp({ engine, pool });

      const runId = await engine.startRun(wf, {});
      await engine.execute(runId);

      const resRuns = await app.request("/runs");
      expect(await resRuns.text()).not.toContain(SECRET_STEP_INPUT);

      const resDetail = await app.request(`/runs/${runId}`);
      expect(await resDetail.text()).not.toContain(SECRET_STEP_INPUT);

      const resEffects = await app.request(`/runs/${runId}/effects`);
      expect(await resEffects.text()).not.toContain(SECRET_STEP_INPUT);
    });

    it("Location 5 (StepCompleted.result): planted secret appears in NO API response", async () => {
      const wf = `wf_sec_5_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return ctx.step(
            "stepWithSecretResult",
            async () => ({
              secretToken: SECRET_STEP_RESULT,
            }),
            {},
          );
        },
      });
      const app = createApiApp({ engine, pool });

      const runId = await engine.startRun(wf, {});
      await engine.execute(runId);

      const resRuns = await app.request("/runs");
      expect(await resRuns.text()).not.toContain(SECRET_STEP_RESULT);

      const resDetail = await app.request(`/runs/${runId}`);
      expect(await resDetail.text()).not.toContain(SECRET_STEP_RESULT);

      const resEffects = await app.request(`/runs/${runId}/effects`);
      expect(await resEffects.text()).not.toContain(SECRET_STEP_RESULT);
    });

    it("Location 6 (EffectCaptured.wouldHaveResult): planted secret appears in NO API response", async () => {
      const wf = `wf_sec_6_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return ctx.step(
            "stepReversible",
            async (_x, sCtx) => {
              await sCtx.sql.query("SELECT 1 AS test");
              return { ok: true };
            },
            {},
            { kind: "effectful-reversible", mock: { secretKey: SECRET_WOULD_HAVE } },
          );
        },
      });
      const app = createApiApp({ engine, pool });

      const parentId = await engine.startRun(wf, {});
      await engine.execute(parentId);

      const forkId = await engine.fork(parentId, 2, { input: {} });
      await engine.execute(forkId);

      const resRuns = await app.request("/runs");
      expect(await resRuns.text()).not.toContain(SECRET_WOULD_HAVE);

      const resDetail = await app.request(`/runs/${forkId}`);
      expect(await resDetail.text()).not.toContain(SECRET_WOULD_HAVE);

      const resEffects = await app.request(`/runs/${forkId}/effects`);
      expect(await resEffects.text()).not.toContain(SECRET_WOULD_HAVE);
    });

    it("Location 7 (EffectCaptured.request): planted secret appears in NO API response", async () => {
      const wf = `wf_sec_7_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return ctx.step(
            "stepHttp",
            async (_x, sCtx) => {
              if (sCtx.mode === "shadow") {
                await sCtx.http.fetch({
                  url: `http://localhost/api?token=${SECRET_EFFECT_REQ}`,
                  headers: { Authorization: `Bearer ${SECRET_EFFECT_REQ}` },
                });
              }
              return { ok: true };
            },
            {},
            { kind: "effectful-external", mock: { done: true } },
          );
        },
      });
      const app = createApiApp({ engine, pool });

      const parentId = await engine.startRun(wf, {});
      await engine.execute(parentId);

      const forkId = await engine.fork(parentId, 2, { input: {} });
      await engine.execute(forkId);

      const resRuns = await app.request("/runs");
      expect(await resRuns.text()).not.toContain(SECRET_EFFECT_REQ);

      const resDetail = await app.request(`/runs/${forkId}`);
      expect(await resDetail.text()).not.toContain(SECRET_EFFECT_REQ);

      const resEffects = await app.request(`/runs/${forkId}/effects`);
      expect(await resEffects.text()).not.toContain(SECRET_EFFECT_REQ);
    });
  });

  describe("API Access Control & Host Binding", () => {
    it("refuses to start on non-loopback host if API_TOKEN is unset", () => {
      const engine = new Engine(pool, {});
      expect(() => {
        startServer({ engine, pool, host: "0.0.0.0" });
      }).toThrow(/Refusing to start API server on non-loopback host '0.0.0.0' without API_TOKEN/i);
    });

    it("mutating endpoints require Authorization: Bearer <API_TOKEN> and reject missing/wrong token without side effects", async () => {
      const token = "secure-secret-token-12345678";
      const wf = `wf_auth_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return await ctx.step("step1", () => "ok", {});
        },
      });
      const app = createApiApp({ engine, pool, apiToken: token });

      // Count runs and tasks before unauthorized calls
      const { rows: initialRuns } = await pool.query<{ count: string }>(
        "SELECT count(*) FROM runs",
      );
      const { rows: initialTasks } = await pool.query<{ count: string }>(
        "SELECT count(*) FROM tasks",
      );

      // 1. Missing Authorization header -> 401
      const resNoAuth = await app.request("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowType: wf, input: {} }),
      });
      expect(resNoAuth.status).toBe(401);
      const errNoAuth = (await resNoAuth.json()) as { error: string };
      expect(errNoAuth.error).toBe("Unauthorized");

      // 2. Wrong token -> 401
      const resBadToken = await app.request("/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-secret-token",
        },
        body: JSON.stringify({ workflowType: wf, input: {} }),
      });
      expect(resBadToken.status).toBe(401);
      const errBadToken = (await resBadToken.json()) as { error: string };
      expect(errBadToken.error).toBe("Unauthorized");

      // Verify no side effects occurred: run and task counts are unchanged
      const { rows: afterRuns } = await pool.query<{ count: string }>("SELECT count(*) FROM runs");
      const { rows: afterTasks } = await pool.query<{ count: string }>(
        "SELECT count(*) FROM tasks",
      );
      expect(afterRuns[0]?.count).toBe(initialRuns[0]?.count);
      expect(afterTasks[0]?.count).toBe(initialTasks[0]?.count);

      // 3. Correct token works -> 201
      const resValid = await app.request("/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ workflowType: wf, input: {} }),
      });
      expect(resValid.status).toBe(201);
      const validJson = (await resValid.json()) as { runId: string };
      expect(validJson.runId).toBeDefined();

      // 4. GET endpoints work without token on loopback
      const resGetRuns = await app.request("/runs");
      expect(resGetRuns.status).toBe(200);

      const resGetRun = await app.request(`/runs/${validJson.runId}`);
      expect(resGetRun.status).toBe(200);

      const resGetEffects = await app.request(`/runs/${validJson.runId}/effects`);
      expect(resGetEffects.status).toBe(200);
    });
  });

  describe("POST /runs/:id/resume Invariants & Concurrency", () => {
    it("two simultaneous resume calls produce exactly 1 task & 1 execution", async () => {
      const wf = `wf_simultaneous_resume_${randomUUID().slice(0, 8)}`;
      let stepExecutions = 0;
      let shouldFail = true;

      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return await ctx.step(
            "single-step",
            () => {
              stepExecutions++;
              if (shouldFail) {
                throw new Error("Simulated initial failure");
              }
              return { executed: true };
            },
            {},
            { maxAttempts: 1 },
          );
        },
      });
      // Start run and execute initial failure
      const runId = await engine.startRun(wf, {});
      const initialOutcome = await engine.execute(runId);
      expect(initialOutcome.status).toBe("failed");
      expect(stepExecutions).toBe(1);

      // Now enable step to succeed on resume
      shouldFail = false;

      // Reset execution counter to verify only 1 execution occurs across concurrent resumes
      let resumeStepExecutions = 0;
      const engineWithCounter = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return await ctx.step(
            "single-step",
            () => {
              resumeStepExecutions++;
              return { resumed: true };
            },
            {},
            { maxAttempts: 1 },
          );
        },
      });
      const appWithCounter = createApiApp({ engine: engineWithCounter, pool });

      // Fire two simultaneous resume calls
      const [res1, res2] = await Promise.all([
        appWithCounter.request(`/runs/${runId}/resume`, { method: "POST" }),
        appWithCounter.request(`/runs/${runId}/resume`, { method: "POST" }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const json1 = (await res1.json()) as { success: boolean; status: string };
      const json2 = (await res2.json()) as { success: boolean; status: string };
      expect(json1.success).toBe(true);
      expect(json2.success).toBe(true);
      expect(json1.status).toBe("completed");
      expect(json2.status).toBe("completed");

      // Verify invariant: exactly 1 step execution occurred
      expect(resumeStepExecutions).toBe(1);

      // Verify invariant: exactly 1 task exists in tasks table for this run
      const { rows: taskRows } = await pool.query<{ count: string }>(
        "SELECT count(*) FROM tasks WHERE run_id = $1",
        [runId],
      );
      expect(Number.parseInt(taskRows[0]!.count, 10)).toBe(1);

      // Verify run status in runs table is completed
      const { rows: runRows } = await pool.query<{ status: string }>(
        "SELECT status FROM runs WHERE id = $1",
        [runId],
      );
      expect(runRows[0]?.status).toBe("completed");
    });

    it("shadow fork stays shadow after resume with 0 live connector calls", async () => {
      const wf = `wf_shadow_resume_${randomUUID().slice(0, 8)}`;
      let liveHttpCalls = 0;
      let stepFailOnce = true;

      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          await ctx.step("step-init", () => "ready", {});
          return await ctx.step(
            "step-connector",
            async (_input, sCtx) => {
              if (sCtx.mode === "live") {
                liveHttpCalls++;
              }
              const res = await sCtx.http.fetch({ url: "https://example.com/api" });
              if (sCtx.mode === "shadow" && stepFailOnce) {
                stepFailOnce = false;
                throw new Error("Transient shadow failure");
              }
              return { res };
            },
            {},
            {
              kind: "effectful-external",
              maxAttempts: 1,
              mock: { status: 200, data: "mocked-shadow-response" },
            },
          );
        },
      });
      const app = createApiApp({ engine, pool });

      // 1. Run parent to completion in live mode
      const parentId = await engine.startRun(wf, {});
      const parentOutcome = await engine.execute(parentId);
      expect(parentOutcome.status).toBe("completed");
      expect(liveHttpCalls).toBe(1);

      // 2. Fork into shadow mode at seq 2
      const forkId = await engine.fork(parentId, 2, { input: {} });

      // Verify fork is created with mode = 'shadow'
      const { rows: forkRowsBefore } = await pool.query<{ mode: string }>(
        "SELECT mode FROM runs WHERE id = $1",
        [forkId],
      );
      expect(forkRowsBefore[0]?.mode).toBe("shadow");

      // 3. Initial execute of fork fails due to transient shadow failure
      const forkInitialOutcome = await engine.execute(forkId);
      expect(forkInitialOutcome.status).toBe("failed");

      // 4. Resume the failed shadow fork via POST /runs/:id/resume
      const resResume = await app.request(`/runs/${forkId}/resume`, { method: "POST" });
      expect(resResume.status).toBe(200);
      const resumeJson = (await resResume.json()) as { success: boolean; status: string };
      expect(resumeJson.success).toBe(true);
      expect(resumeJson.status).toBe("completed");

      // 5. Invariants verification:
      // (a) Mode stays 'shadow'
      const { rows: forkRowsAfter } = await pool.query<{ mode: string; status: string }>(
        "SELECT mode, status FROM runs WHERE id = $1",
        [forkId],
      );
      expect(forkRowsAfter[0]?.mode).toBe("shadow");
      expect(forkRowsAfter[0]?.status).toBe("completed");

      // (b) Zero live connector calls were made by the shadow fork (only parent's 1 call)
      expect(liveHttpCalls).toBe(1);

      // (c) Effect was captured as shadow effect in events table
      const forkEvents = await loadEvents(pool, forkId);
      const effectEvents = forkEvents.filter((e) => e.type === "EffectCaptured");
      expect(effectEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("resume of completed run is a safe no-op with clear response", async () => {
      const wf = `wf_completed_resume_${randomUUID().slice(0, 8)}`;
      let executionCount = 0;

      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return await ctx.step(
            "step-done",
            () => {
              executionCount++;
              return "done";
            },
            {},
          );
        },
      });
      const app = createApiApp({ engine, pool });

      const runId = await engine.startRun(wf, {});
      const outcome = await engine.execute(runId);
      expect(outcome.status).toBe("completed");
      expect(executionCount).toBe(1);

      const eventsBefore = await loadEvents(pool, runId);
      const { rows: tasksBefore } = await pool.query<{ count: string }>(
        "SELECT count(*) FROM tasks WHERE run_id = $1",
        [runId],
      );

      // Call resume on completed run
      const res = await app.request(`/runs/${runId}/resume`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        runId: string;
        status: string;
        message: string;
      };
      expect(body.success).toBe(true);
      expect(body.runId).toBe(runId);
      expect(body.status).toBe("completed");
      expect(body.message).toBe("Run is already completed");

      // Step was not executed again
      expect(executionCount).toBe(1);

      // No new events appended
      const eventsAfter = await loadEvents(pool, runId);
      expect(eventsAfter.length).toBe(eventsBefore.length);

      // No tasks created or modified
      const { rows: tasksAfter } = await pool.query<{ count: string }>(
        "SELECT count(*) FROM tasks WHERE run_id = $1",
        [runId],
      );
      expect(tasksAfter[0]?.count).toBe(tasksBefore[0]?.count);
    });

    it("two concurrent resumes on a pool of size 1 succeed without deadlocking and with 0 leaked locks", async () => {
      // Create a dedicated pool of size 1
      const tinyPool = await makePool(1);
      const wf = `wf_pool1_resume_${randomUUID().slice(0, 8)}`;
      let executionCount = 0;
      let shouldFail = true;

      const engine = new Engine(tinyPool, {
        [wf]: async (ctx: Ctx) => {
          return await ctx.step(
            "step-tiny",
            () => {
              executionCount++;
              if (shouldFail) {
                throw new Error("Initial failure for pool size 1 test");
              }
              return "success-pool1";
            },
            {},
            { maxAttempts: 1 },
          );
        },
      });

      const runId = await engine.startRun(wf, {});
      const outFail = await engine.execute(runId);
      expect(outFail.status).toBe("failed");
      expect(executionCount).toBe(1);

      // Now enable step to succeed on resume
      shouldFail = false;
      let resumeCalls = 0;

      const engineResumed = new Engine(tinyPool, {
        [wf]: async (ctx: Ctx) => {
          return await ctx.step(
            "step-tiny",
            () => {
              resumeCalls++;
              return "success-pool1";
            },
            {},
            { maxAttempts: 1 },
          );
        },
      });
      const appResumed = createApiApp({ engine: engineResumed, pool: tinyPool });

      // Run two concurrent resumes on pool of size 1
      const [r1, r2] = await Promise.all([
        appResumed.request(`/runs/${runId}/resume`, { method: "POST" }),
        appResumed.request(`/runs/${runId}/resume`, { method: "POST" }),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(resumeCalls).toBe(1);

      // Verify no advisory locks leaked in pg_locks
      const { rows: lockRows } = await tinyPool.query<{ count: string }>(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'",
      );
      expect(Number.parseInt(lockRows[0]!.count, 10)).toBe(0);

      await tinyPool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
      await tinyPool.end();
    });

    it("an aborted resume request automatically releases transaction-level advisory lock in pg_locks", async () => {
      const tinyPool = await makePool(2);
      const wf = `wf_abort_lock_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(tinyPool, {
        [wf]: async (ctx: Ctx) => {
          return await ctx.step(
            "step-abort",
            () => {
              throw new Error("Forced execution failure inside step");
            },
            {},
            { maxAttempts: 1 },
          );
        },
      });
      const app = createApiApp({ engine, pool: tinyPool });

      const runId = await engine.startRun(wf, {});
      await engine.execute(runId);

      // Call resume which fails execution
      const res = await app.request(`/runs/${runId}/resume`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; status: string };
      expect(body.status).toBe("failed");

      // Assert that transaction advisory lock was released immediately
      const { rows: lockRows } = await tinyPool.query<{ count: string }>(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'",
      );
      expect(Number.parseInt(lockRows[0]!.count, 10)).toBe(0);

      // Also verify explicitly that an aborted/rolled-back transaction releases pg_advisory_xact_lock
      const client = await tinyPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('aborted-run'))");
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      const { rows: lockRows2 } = await tinyPool.query<{ count: string }>(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'",
      );
      expect(Number.parseInt(lockRows2[0]!.count, 10)).toBe(0);

      await tinyPool.query("DELETE FROM tasks WHERE run_id = $1", [runId]);
      await tinyPool.end();
    });
  });

  describe("DNS Rebinding Protection & Host Validation", () => {
    it("isLoopback correctly validates loopback host variants and rejects non-loopback hosts", () => {
      // Loopback hosts allowed
      expect(isLoopback("localhost")).toBe(true);
      expect(isLoopback("localhost:3000")).toBe(true);
      expect(isLoopback("127.0.0.1")).toBe(true);
      expect(isLoopback("127.0.0.1:3000")).toBe(true);
      expect(isLoopback("127.0.0.42:5173")).toBe(true);
      expect(isLoopback("127.255.255.255")).toBe(true);
      expect(isLoopback("::1")).toBe(true);
      expect(isLoopback("[::1]")).toBe(true);
      expect(isLoopback("[::1]:3000")).toBe(true);

      // Non-loopback hosts strictly rejected
      expect(isLoopback("evil.example")).toBe(false);
      expect(isLoopback("evil.example:3000")).toBe(false);
      expect(isLoopback("attacker.com")).toBe(false);
      expect(isLoopback("192.168.1.1")).toBe(false);
      expect(isLoopback("10.0.0.1")).toBe(false);
      expect(isLoopback("0.0.0.0")).toBe(false);
    });

    it("rejects requests with Host: evil.example with 403 Forbidden on all routes without executing", async () => {
      const engine = new Engine(pool, {});
      const app = createApiApp({ engine, pool });

      // 1. GET /health with evil Host
      const resHealth = await app.request("/health", {
        headers: { Host: "evil.example" },
      });
      expect(resHealth.status).toBe(403);
      const jsonHealth = (await resHealth.json()) as { error: string };
      expect(jsonHealth.error).toContain("DNS rebinding protection");

      // 2. GET /runs with evil Host
      const resRuns = await app.request("/runs", {
        headers: { Host: "evil.example:3000" },
      });
      expect(resRuns.status).toBe(403);

      // 3. POST /runs with evil Host
      const resPost = await app.request("/runs", {
        method: "POST",
        headers: {
          Host: "attacker.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workflowType: "foo", input: {} }),
      });
      expect(resPost.status).toBe(403);
    });
  });

  describe("POST /runs Endpoint Hardening & Registered Workflows", () => {
    it("rejects unregistered workflow types with 400 Bad Request and lists registered types", async () => {
      const registeredWf = `wf_registered_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [registeredWf]: async (ctx: Ctx) => {
          return await ctx.step("s1", () => "done", {});
        },
      });
      const app = createApiApp({ engine, pool });

      const res = await app.request("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowType: "unknown-unregistered-workflow", input: {} }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Unknown workflow type: 'unknown-unregistered-workflow'");
      expect(body.error).toContain(registeredWf);
    });

    it("rejects invalid JSON or missing workflowType with 400 Zod error", async () => {
      const engine = new Engine(pool, {});
      const app = createApiApp({ engine, pool });

      const resMissing = await app.request("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });
      expect(resMissing.status).toBe(400);
      const bodyMissing = (await resMissing.json()) as { error: string; issues: unknown[] };
      expect(bodyMissing.error).toBe("Validation failed");
      expect(bodyMissing.issues.length).toBeGreaterThan(0);
    });

    it("accepts registered workflow type and starts run returning 201 with runId", async () => {
      const wf = `wf_start_valid_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return await ctx.step("s1", () => "ok", {});
        },
      });
      const app = createApiApp({ engine, pool });

      const res = await app.request("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowType: wf, input: { foo: "bar" } }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { runId: string };
      expect(body.runId).toBeDefined();

      // Clean up task
      await pool.query("DELETE FROM tasks WHERE run_id = $1", [body.runId]);
    });
  });

  describe("Pagination & True Total Computation", () => {
    it("computes true total count using COUNT(*) and caps page limit at maxLimit (50)", async () => {
      const wf = `wf_pagination_batch_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return await ctx.step("p-step", () => "p-done", {});
        },
      });
      const app = createApiApp({ engine, pool, maxLimit: 50 });

      // Create 65 runs in database
      const runIds: string[] = [];
      for (let i = 0; i < 65; i++) {
        const id = await engine.startRun(wf, { idx: i });
        runIds.push(id);
      }

      // Query runs with requested limit = 10
      const resLimit10 = await app.request(`/runs?limit=10`);
      expect(resLimit10.status).toBe(200);
      const data10 = (await resLimit10.json()) as { runs: unknown[]; total: number };
      expect(data10.runs.length).toBe(10);
      expect(data10.total).toBeGreaterThanOrEqual(65);
      expect(resLimit10.headers.get("x-total-count")).toBe(String(data10.total));

      // Query runs with requested limit = 1000 (should be capped at maxLimit 50)
      const resCapped = await app.request(`/runs?limit=1000`);
      expect(resCapped.status).toBe(200);
      const dataCapped = (await resCapped.json()) as { runs: unknown[]; total: number };
      expect(dataCapped.runs.length).toBe(50);
      expect(dataCapped.total).toBe(data10.total);

      // Clean up tasks
      await pool.query("DELETE FROM tasks WHERE run_id = ANY($1::uuid[])", [runIds]);
    });
  });
});

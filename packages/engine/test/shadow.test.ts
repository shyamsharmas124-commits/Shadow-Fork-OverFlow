import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import http, { request as esmHttpRequest } from "node:http";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Ctx,
  Engine,
  type ForkOptions,
  loadEvents,
  RunContext,
  ShadowEgressError,
  ShadowSqlConnector,
  type StepContext,
} from "../src/index.js";
import { makePool } from "./helpers.js";

describe("Milestone 4b - Shadow Mode", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await makePool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shadow_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        balance integer NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS shadow_accounts CASCADE");
    await pool.end();
  });

  it("HTTP connector: live sends request; shadow captures without sending and redacts secrets", async () => {
    let serverRequestCount = 0;
    let receivedAuthHeader = "";

    // Local HTTP server to verify network calls
    const server = http.createServer((req, res) => {
      serverRequestCount++;
      receivedAuthHeader = req.headers.authorization ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "paid", chargeId: "ch_live_123" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/charge`;

    try {
      const wf = `wf_http_shadow_${randomUUID().slice(0, 8)}`;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx, input: { amount: number }) => {
          const res = await ctx.step(
            "charge-card",
            async (stepAmount: number, sctx: StepContext) => {
              const resp = await sctx.http.fetch({
                url,
                method: "POST",
                headers: {
                  Authorization: "Bearer super_secret_token_abc",
                  Cookie: "session=secret_session_cookie",
                  "X-Custom-Secret": "sensitive_data",
                  "X-Api-Key": "my_api_key_xyz",
                  "Content-Type": "application/json",
                },
                body: { amount: stepAmount },
              });
              return resp.body as { status: string; chargeId: string };
            },
            input.amount,
            { kind: "effectful-external" },
          );
          return res;
        },
      });

      // 1. Live Run: sends 1 real HTTP request
      const liveRunId = await engine.startRun(wf, { amount: 50 });
      const liveOutcome = await engine.execute(liveRunId);
      expect(liveOutcome.status).toBe("completed");
      expect(serverRequestCount).toBe(1);
      expect(receivedAuthHeader).toBe("Bearer super_secret_token_abc");

      // Reset server request counter
      const prevServerRequests = serverRequestCount;

      // 2. Shadow Fork: reuses parent result, captures request without sending (0 HTTP requests sent!)
      const forkedRunId = await engine.fork(liveRunId, 2, { input: 75 }); // fork at step 1
      const forkOutcome = await engine.execute(forkedRunId);
      expect(forkOutcome.status).toBe("completed");
      if (forkOutcome.status === "completed") {
        expect(forkOutcome.result).toEqual({ status: "paid", chargeId: "ch_live_123" });
      }

      // Assert local HTTP server received 0 new requests from the shadow fork!
      expect(serverRequestCount).toBe(prevServerRequests);

      // Verify captured effect event in fork
      const forkEvents = await loadEvents(pool, forkedRunId);
      const effectEvent = forkEvents.find((e) => e.type === "EffectCaptured");
      expect(effectEvent).toBeDefined();

      const effectPayload = effectEvent!.payload as {
        stepName: string;
        kind: string;
        request: {
          url: string;
          method: string;
          headers: Record<string, string>;
          body: { amount: number };
        };
        wouldHaveResult: unknown;
        resultSource: string;
      };

      expect(effectPayload.stepName).toBe("charge-card");
      expect(effectPayload.kind).toBe("effectful-external");
      expect(effectPayload.resultSource).toBe("original");
      expect(effectPayload.wouldHaveResult).toEqual({ status: "paid", chargeId: "ch_live_123" });
      expect(effectPayload.request.url).toBe(url);
      expect(effectPayload.request.method).toBe("POST");
      expect(effectPayload.request.body).toEqual({ amount: 75 });

      // Verify secrets redaction: Authorization, Cookie, X-Custom-Secret, X-Api-Key must be [REDACTED]
      expect(effectPayload.request.headers.Authorization).toBe("[REDACTED]");
      expect(effectPayload.request.headers.Cookie).toBe("[REDACTED]");
      expect(effectPayload.request.headers["X-Custom-Secret"]).toBe("[REDACTED]");
      expect(effectPayload.request.headers["X-Api-Key"]).toBe("[REDACTED]");
      expect(effectPayload.request.headers["Content-Type"]).toBe("application/json");

      // Verify original secret tokens are nowhere in the event log
      const serializedEvents = JSON.stringify(forkEvents);
      expect(serializedEvents).not.toContain("super_secret_token_abc");
      expect(serializedEvents).not.toContain("secret_session_cookie");
      expect(serializedEvents).not.toContain("sensitive_data");
      expect(serializedEvents).not.toContain("my_api_key_xyz");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("SQL connector: shadow executes in transaction, records affected rows, and ROLLBACKs", async () => {
    const accountId = randomUUID();
    await pool.query(`INSERT INTO shadow_accounts (id, name, balance) VALUES ($1, 'Alice', 100)`, [
      accountId,
    ]);

    const wf = `wf_sql_shadow_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { accId: string; delta: number }) => {
        const updateRes = await ctx.step(
          "update-balance",
          async (_inp, sctx: StepContext) => {
            const res = await sctx.sql.query(
              `UPDATE shadow_accounts SET balance = balance + $1 WHERE id = $2`,
              [input.delta, input.accId],
            );
            return { updated: res.rowCount };
          },
          input,
          { kind: "effectful-reversible" },
        );
        return updateRes;
      },
    });

    // 1. Live Run: increments balance by 50 -> 150
    const liveRunId = await engine.startRun(wf, { accId: accountId, delta: 50 });
    const liveOutcome = await engine.execute(liveRunId);
    expect(liveOutcome.status).toBe("completed");

    const { rows: afterLive } = await pool.query<{ balance: number }>(
      `SELECT balance FROM shadow_accounts WHERE id = $1`,
      [accountId],
    );
    expect(afterLive[0]!.balance).toBe(150);

    // 2. Shadow Fork: attempts to update balance by +500
    // In shadow mode, query executes inside a transaction, records affected rows, then rolls back!
    const forkedRunId = await engine.fork(liveRunId, 2, {
      input: { accId: accountId, delta: 500 },
    });
    const forkOutcome = await engine.execute(forkedRunId);
    expect(forkOutcome.status).toBe("completed");

    // Assert database rows are UNCHANGED (still 150)!
    const { rows: afterFork } = await pool.query<{ balance: number }>(
      `SELECT balance FROM shadow_accounts WHERE id = $1`,
      [accountId],
    );
    expect(afterFork[0]!.balance).toBe(150);

    // Assert EffectCaptured records the would-have affected row count
    const forkEvents = await loadEvents(pool, forkedRunId);
    const effectEvent = forkEvents.find((e) => e.type === "EffectCaptured");
    expect(effectEvent).toBeDefined();

    const effectPayload = effectEvent!.payload as {
      stepName: string;
      kind: string;
      request: { totalAffectedRows: number; queries: Array<{ sql: string; affectedRows: number }> };
      wouldHaveResult: unknown;
    };

    expect(effectPayload.stepName).toBe("update-balance");
    expect(effectPayload.kind).toBe("effectful-reversible");
    expect(effectPayload.request.totalAffectedRows).toBe(1);
    expect(effectPayload.request.queries[0]!.affectedRows).toBe(1);
  });

  it("SQL connector: step that throws mid-query leaves no open transactions (pg_stat_activity) and rolls back", async () => {
    const accountId = randomUUID();
    await pool.query(`INSERT INTO shadow_accounts (id, name, balance) VALUES ($1, 'Bob', 200)`, [
      accountId,
    ]);

    const wf = `wf_sql_throw_${randomUUID().slice(0, 8)}`;
    let shouldThrow = false;
    let dedicatedPid: number | null = null;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { accId: string }) => {
        await ctx.step("step-init", () => "ready", {}, { kind: "pure" });
        return await ctx.step(
          "throw-step",
          async (_inp, sctx: StepContext) => {
            if (shouldThrow) {
              await sctx.sql.query(`UPDATE shadow_accounts SET balance = 9999 WHERE id = $1`, [
                input.accId,
              ]);
              if (sctx.sql instanceof ShadowSqlConnector) {
                dedicatedPid = sctx.sql.backendPid;
              }
              throw new Error("Crash mid-query in step function!");
            }
            return { balance: 200 };
          },
          input,
          { kind: "effectful-reversible", maxAttempts: 1, mock: { failed: true } },
        );
      },
    });

    // Parent run: runs cleanly without throwing
    const parentRunId = await engine.startRun(wf, { accId: accountId });
    const parentOutcome = await engine.execute(parentRunId);
    expect(parentOutcome.status).toBe("completed");

    // Shadow Fork: runs in shadow mode and throws mid-query
    shouldThrow = true;
    const forkedRunId = await engine.fork(parentRunId, 2, { input: { accId: accountId } });
    const forkOutcome = await engine.execute(forkedRunId);
    expect(forkOutcome.status).toBe("failed");

    // Verify dedicated client in Postgres leaves no open transaction (pg_stat_activity)
    expect(dedicatedPid).not.toBeNull();
    const { rows: idleTxRows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction' AND pid = $1`,
      [dedicatedPid],
    );
    expect(Number(idleTxRows[0]!.count)).toBe(0);

    // Balance in table remains 200 (rolled back completely)
    const { rows: finalRows } = await pool.query<{ balance: number }>(
      `SELECT balance FROM shadow_accounts WHERE id = $1`,
      [accountId],
    );
    expect(finalRows[0]!.balance).toBe(200);
  });

  it("step classification: pure runs normally; unclassified defaults to effectful-external", async () => {
    let pureLiveRuns = 0;
    const wf = `wf_classify_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { n: number }) => {
        const sPure = await ctx.step(
          "pure-math",
          (x: number) => {
            pureLiveRuns++;
            return x * 10;
          },
          input.n,
          { kind: "pure" },
        );

        // Unclassified step: defaults to effectful-external
        const sUnclassified = await ctx.step(
          "unclassified-step",
          (_x: number) => {
            return "live-only-output";
          },
          sPure,
        );

        return { sPure, sUnclassified };
      },
    });

    const liveId = await engine.startRun(wf, { n: 3 });
    const liveOutcome = await engine.execute(liveId);
    expect(liveOutcome.status).toBe("completed");
    expect(pureLiveRuns).toBe(1);

    // Fork at step 1 with new input 5
    const forkId = await engine.fork(liveId, 2, { input: 5 }); // forked run in shadow mode
    const forkOutcome = await engine.execute(forkId);
    expect(forkOutcome.status).toBe("completed");

    // Pure step ran normally in shadow fork (execution counter incremented to 2, computed 5 * 10 = 50)
    expect(pureLiveRuns).toBe(2);

    // Unclassified step was treated as effectful-external, ran in shadow mode, and reused parent's recorded result!
    if (forkOutcome.status === "completed") {
      expect(forkOutcome.result).toEqual({ sPure: 50, sUnclassified: "live-only-output" });
    }

    const forkEvents = await loadEvents(pool, forkId);
    const effectEvent = forkEvents.find(
      (e) =>
        e.type === "EffectCaptured" &&
        (e.payload as { stepName: string }).stepName === "unclassified-step",
    );
    expect(effectEvent).toBeDefined();
    expect((effectEvent!.payload as { kind: string }).kind).toBe("effectful-external");
  });

  it("shadow mode reuses parent result keyed by (stepName, occurrenceIndex)", async () => {
    const wf = `wf_multi_occurrence_shadow_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx) => {
        const call0 = await ctx.step(
          "call-api",
          async () => ({ result: "live-call-0" }),
          {},
          { kind: "effectful-external" },
        );
        const call1 = await ctx.step(
          "call-api",
          async () => ({ result: "live-call-1" }),
          {},
          { kind: "effectful-external" },
        );
        return { call0, call1 };
      },
    });

    const liveId = await engine.startRun(wf, {});
    const liveOutcome = await engine.execute(liveId);
    expect(liveOutcome.status).toBe("completed");
    if (liveOutcome.status === "completed") {
      expect(liveOutcome.result).toEqual({
        call0: { result: "live-call-0" },
        call1: { result: "live-call-1" },
      });
    }

    // Fork at seq 2 (call-api occurrence 0)
    const forkId = await engine.fork(liveId, 2, { input: {} });
    const forkOutcome = await engine.execute(forkId);
    expect(forkOutcome.status).toBe("completed");

    // Both occurrences received their own recorded result from parent, not the first one's for both!
    if (forkOutcome.status === "completed") {
      expect(forkOutcome.result).toEqual({
        call0: { result: "live-call-0" },
        call1: { result: "live-call-1" },
      });
    }
  });

  it("shadow retries capture one EffectCaptured per attempt tagged with attempt number", async () => {
    let callAttempts = 0;
    const wf = `wf_shadow_retries_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx) => {
        return await ctx.step(
          "flaky-shadow",
          async (_inp, sctx: StepContext) => {
            callAttempts++;
            if (sctx.mode === "shadow") {
              await sctx.http.fetch({ url: "http://example.com/api" });
              if (callAttempts < 2) {
                throw new Error(`Transient shadow failure attempt ${callAttempts}`);
              }
            }
            return { done: true };
          },
          {},
          {
            kind: "effectful-external",
            maxAttempts: 2,
            initialBackoffMs: 10,
            mock: { done: true },
          },
        );
      },
    });

    // Run live parent first
    const parentId = await engine.startRun(wf, {});
    await engine.execute(parentId);

    callAttempts = 0;
    // Fork into shadow run
    const forkId = await engine.fork(parentId, 2, { input: {} });

    // Attempt 1 fails
    const outcome1 = await engine.execute(forkId);
    expect(outcome1.status).toBe("running");
    expect(callAttempts).toBe(1);

    // Wait for backoff
    await new Promise((r) => setTimeout(r, 25));

    // Attempt 2 succeeds
    const outcome2 = await engine.execute(forkId);
    expect(outcome2.status).toBe("completed");
    expect(callAttempts).toBe(2);

    // Verify events: two EffectCaptured events, tagged with attempt 1 and attempt 2
    const forkEvents = await loadEvents(pool, forkId);
    const effectEvents = forkEvents.filter((e) => e.type === "EffectCaptured");
    expect(effectEvents.length).toBe(2);

    expect((effectEvents[0]!.payload as { attempt: number }).attempt).toBe(1);
    expect((effectEvents[1]!.payload as { attempt: number }).attempt).toBe(2);
  });

  it("shadow mode is stored on the run row and cannot be disabled by accident", async () => {
    const wf = `wf_mode_stored_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx) => {
        return await ctx.step("stepA", () => 10, {}, { kind: "pure" });
      },
    });

    const parentId = await engine.startRun(wf, {});
    await engine.execute(parentId);
    const forkId = await engine.fork(parentId, 2, { result: 10 });

    const { rows: parentRows } = await pool.query<{ mode: string }>(
      `SELECT mode FROM runs WHERE id = $1`,
      [parentId],
    );
    const { rows: forkRows } = await pool.query<{ mode: string }>(
      `SELECT mode FROM runs WHERE id = $1`,
      [forkId],
    );

    expect(parentRows[0]!.mode).toBe("live");
    expect(forkRows[0]!.mode).toBe("shadow");
    await engine.execute(forkId);
  });

  it("replay of a completed forked run does not call any connector", async () => {
    let httpCalls = 0;
    let sqlCalls = 0;
    const wf = `wf_replay_no_connector_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx) => {
        return await ctx.step(
          "shadow-step",
          async (_inp, sctx: StepContext) => {
            if (sctx.mode === "shadow") {
              await sctx.http.fetch({ url: "http://example.com/test" });
              await sctx.sql.query("SELECT 1");
              httpCalls++;
              sqlCalls++;
            }
            return { ok: true };
          },
          {},
          { kind: "effectful-external", mock: { ok: true } },
        );
      },
    });

    const parentId = await engine.startRun(wf, {});
    await engine.execute(parentId);

    const forkId = await engine.fork(parentId, 2, { input: {} });
    await engine.execute(forkId);

    expect(httpCalls).toBe(1);
    expect(sqlCalls).toBe(1);

    // Replay 1: execute again on completed forked run via engine
    const replayOutcome = await engine.execute(forkId);
    expect(replayOutcome.status).toBe("completed");

    // Replay 2: directly replay history through RunContext and re-execute workflow function
    const history = (await loadEvents(pool, forkId)).filter(
      (e) => e.type !== "RunStarted" && e.type !== "RunCompleted",
    );
    const replayCtx = new RunContext(pool, forkId, history, { runMode: "shadow" });
    const wfFn = (
      engine as unknown as { workflows: Record<string, (c: Ctx, i: unknown) => Promise<unknown>> }
    ).workflows[wf];
    await wfFn!(replayCtx, {});

    // Connector calls remain 1 (connectors are NEVER called during replay!)
    expect(httpCalls).toBe(1);
    expect(sqlCalls).toBe(1);
  });

  it("abandoned shadow attempt: timeout captures EffectCaptured for attempt 1, and late resolution writes no late event", async () => {
    let attemptCount = 0;
    let lateResolutionDone = false;
    const wf = `wf_abandoned_shadow_${randomUUID().slice(0, 8)}`;

    let isFork = false;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx) => {
        await ctx.step("step-init", () => "ready", {}, { kind: "pure" });
        return await ctx.step(
          "slow-shadow-step",
          async (_inp, sctx: StepContext) => {
            attemptCount++;
            if (sctx.mode === "shadow") {
              await sctx.http.fetch({ url: "http://example.com/slow" });
            }
            if (isFork && attemptCount === 1) {
              return new Promise<{ res: string }>((resolve) => {
                setTimeout(() => {
                  lateResolutionDone = true;
                  resolve({ res: "rogue-late-shadow" });
                }, 120);
              });
            }
            return { res: "clean-shadow-2" };
          },
          {},
          {
            kind: "effectful-external",
            timeoutMs: 40,
            maxAttempts: 2,
            initialBackoffMs: 10,
            mock: { res: "clean-shadow-2" },
          },
        );
      },
    });

    const parentId = await engine.startRun(wf, {});
    await engine.execute(parentId);

    isFork = true;
    attemptCount = 0;
    const forkId = await engine.fork(parentId, 2, { input: {} });

    // Capture parent tasks and events before fork runs
    const { rows: parentTasksBefore } = await pool.query(
      `SELECT id, step_key, status, attempt FROM tasks WHERE run_id = $1 ORDER BY id`,
      [parentId],
    );
    const parentEventsBefore = await loadEvents(pool, parentId);

    // Attempt 1 times out after 40ms
    const outcome1 = await engine.execute(forkId);
    expect(outcome1.status).toBe("running");
    expect(attemptCount).toBe(1);

    // Wait past the 10ms backoff
    await new Promise((r) => setTimeout(r, 25));

    // Attempt 2 succeeds
    const outcome2 = await engine.execute(forkId);
    expect(outcome2.status).toBe("completed");
    expect(attemptCount).toBe(2);

    // Wait for attempt 1 late resolution at 120ms
    await new Promise((r) => setTimeout(r, 120));
    expect(lateResolutionDone).toBe(true);

    // Verify events: exactly two EffectCaptured events (attempt 1 and attempt 2), NO late event
    const forkEvents = await loadEvents(pool, forkId);
    const effectEvents = forkEvents.filter((e) => e.type === "EffectCaptured");
    expect(effectEvents.length).toBe(2);
    expect((effectEvents[0]!.payload as { attempt: number }).attempt).toBe(1);
    expect((effectEvents[1]!.payload as { attempt: number }).attempt).toBe(2);

    // Assert fork never wrote to tasks or events of its parent
    const { rows: parentTasksAfter } = await pool.query(
      `SELECT id, step_key, status, attempt FROM tasks WHERE run_id = $1 ORDER BY id`,
      [parentId],
    );
    const parentEventsAfter = await loadEvents(pool, parentId);
    expect(parentTasksAfter).toEqual(parentTasksBefore);
    expect(parentEventsAfter).toEqual(parentEventsBefore);
  });

  it("parent untouched: parent runs row, all events, and all tasks are byte-identical before and after fork completion", async () => {
    const wf = `wf_parent_snapshot_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { n: number }) => {
        const a = await ctx.step("stepA", async (x: number) => x + 1, input.n, { kind: "pure" });
        const b = await ctx.step(
          "stepB",
          async () => ({ status: "ok", code: 200 }),
          {},
          { kind: "effectful-external" },
        );
        return { a, b };
      },
    });

    const parentId = await engine.startRun(wf, { n: 10 });
    const parentOutcome = await engine.execute(parentId);
    expect(parentOutcome.status).toBe("completed");

    // Take complete snapshot of parent in database before fork
    const { rows: parentRunBefore } = await pool.query(`SELECT * FROM runs WHERE id = $1`, [
      parentId,
    ]);
    const { rows: parentEventsBefore } = await pool.query(
      `SELECT * FROM events WHERE run_id = $1 ORDER BY seq ASC`,
      [parentId],
    );
    const { rows: parentTasksBefore } = await pool.query(
      `SELECT * FROM tasks WHERE run_id = $1 ORDER BY id ASC`,
      [parentId],
    );

    const snapshotRunBefore = JSON.stringify(parentRunBefore);
    const snapshotEventsBefore = JSON.stringify(parentEventsBefore);
    const snapshotTasksBefore = JSON.stringify(parentTasksBefore);

    // Create and execute fork to completion in shadow mode
    const forkId = await engine.fork(parentId, 2, { input: 99 });
    const forkOutcome = await engine.execute(forkId);
    expect(forkOutcome.status).toBe("completed");

    // Take complete snapshot of parent in database after fork
    const { rows: parentRunAfter } = await pool.query(`SELECT * FROM runs WHERE id = $1`, [
      parentId,
    ]);
    const { rows: parentEventsAfter } = await pool.query(
      `SELECT * FROM events WHERE run_id = $1 ORDER BY seq ASC`,
      [parentId],
    );
    const { rows: parentTasksAfter } = await pool.query(
      `SELECT * FROM tasks WHERE run_id = $1 ORDER BY id ASC`,
      [parentId],
    );

    const snapshotRunAfter = JSON.stringify(parentRunAfter);
    const snapshotEventsAfter = JSON.stringify(parentEventsAfter);
    const snapshotTasksAfter = JSON.stringify(parentTasksAfter);

    // Byte-identical assertion
    expect(snapshotRunAfter).toBe(snapshotRunBefore);
    expect(snapshotEventsAfter).toBe(snapshotEventsBefore);
    expect(snapshotTasksAfter).toBe(snapshotTasksBefore);
  });

  it("removes mode from public ForkOptions; passing mode is rejected at runtime and typecheck", async () => {
    const wf = `wf_mode_reject_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx) => ctx.step("s1", () => 1, {}, { kind: "pure" }),
    });

    const parentId = await engine.startRun(wf, {});
    await engine.execute(parentId);

    // Compile-time type error:
    // @ts-expect-error mode is not allowed on ForkOptions
    const invalidOptions: ForkOptions = { mode: "live" };

    // Runtime rejection:
    await expect(
      (
        engine.fork as unknown as (
          p: string,
          seq: number,
          edit: unknown,
          opts: unknown,
        ) => Promise<string>
      )(parentId, 2, { input: {} }, invalidOptions),
    ).rejects.toThrow(/Forks are always shadow: specifying mode is not supported\./);
  });

  it("egress guard: shadow step calling raw fetch throws ShadowEgressError, 0 HTTP requests sent; live run unaffected", async () => {
    let serverHitCount = 0;
    const server = http.createServer((_req, res) => {
      serverHitCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const testUrl = `http://localhost:${port}/raw-egress`;

    try {
      const wf = `wf_egress_guard_${randomUUID().slice(0, 8)}`;

      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          return await ctx.step(
            "fetch-step",
            async () => {
              // Direct raw fetch call (bypassing ctx.http!)
              const res = await globalThis.fetch(testUrl);
              return await res.json();
            },
            {},
            { kind: "effectful-external", mock: { status: "shadow-mocked" } },
          );
        },
      });

      // 1. Live run: direct fetch is allowed and succeeds
      const liveId = await engine.startRun(wf, {});
      const liveOutcome = await engine.execute(liveId);
      expect(liveOutcome.status).toBe("completed");
      expect(serverHitCount).toBe(1);

      // 2. Fork in shadow mode: direct fetch is blocked by AsyncLocalStorage egress guard!
      const forkId = await engine.fork(liveId, 2, { input: {} });
      const forkOutcome = await engine.execute(forkId);
      expect(forkOutcome.status).toBe("failed");
      if (forkOutcome.status === "failed") {
        expect(forkOutcome.error).toContain("Shadow egress violation");
      }
      // Server received ZERO additional requests from the shadow step!
      expect(serverHitCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("redaction: redacts secret values in URL query parameters and JSON or form-encoded bodies", async () => {
    const wf = `wf_redact_ext_${randomUUID().slice(0, 8)}`;

    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx) => {
        return await ctx.step(
          "redacted-step",
          async (_inp, sctx: StepContext) => {
            if (sctx.mode === "shadow") {
              // Call shadow http with sensitive URL query params and nested body
              await sctx.http.fetch({
                url: "http://example.com/checkout?user_token=tok_secret_123&api_key=my_key_999&signature=sig_abc&password=p_secret&auth=secret_auth_param_val_99&regular=visible",
                method: "POST",
                headers: {
                  Authorization: "Bearer sensitive_bearer",
                  Cookie: "sid=secret_cookie_val",
                  "X-App-Token": "app_token_secret",
                  "Content-Type": "application/json",
                },
                body: {
                  user: "alice",
                  api_secret: "super_secret_password",
                  auth_token: "tok_in_body_secret",
                  nested: {
                    signature_key: "nested_key_secret",
                  },
                },
              });
            }
            return { processed: true };
          },
          {},
          { kind: "effectful-external", mock: { processed: true } },
        );
      },
    });

    const parentId = await engine.startRun(wf, {});
    await engine.execute(parentId);

    const forkId = await engine.fork(parentId, 2, { input: {} });
    const forkOutcome = await engine.execute(forkId);
    expect(forkOutcome.status).toBe("completed");

    const events = await loadEvents(pool, forkId);
    const effectEvent = events.find((e) => e.type === "EffectCaptured");
    expect(effectEvent).toBeDefined();

    const payload = effectEvent!.payload as {
      request: {
        url: string;
        headers: Record<string, string>;
        body: Record<string, unknown>;
      };
    };

    // Assert URL query params redacted
    expect(payload.request.url).toContain("user_token=[REDACTED]");
    expect(payload.request.url).toContain("api_key=[REDACTED]");
    expect(payload.request.url).toContain("signature=[REDACTED]");
    expect(payload.request.url).toContain("password=[REDACTED]");
    expect(payload.request.url).toContain("auth=[REDACTED]");
    expect(payload.request.url).toContain("regular=visible");

    // Assert body fields redacted
    expect(payload.request.body.user).toBe("alice");
    expect(payload.request.body.api_secret).toBe("[REDACTED]");
    expect(payload.request.body.auth_token).toBe("[REDACTED]");
    expect((payload.request.body.nested as Record<string, unknown>).signature_key).toBe(
      "[REDACTED]",
    );

    // Assert original secret values are nowhere in the event log
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("tok_secret_123");
    expect(serialized).not.toContain("my_key_999");
    expect(serialized).not.toContain("sig_abc");
    expect(serialized).not.toContain("p_secret");
    expect(serialized).not.toContain("secret_auth_param_val_99");
    expect(serialized).not.toContain("super_secret_password");
    expect(serialized).not.toContain("tok_in_body_secret");
    expect(serialized).not.toContain("nested_key_secret");
    expect(serialized).not.toContain("sensitive_bearer");
    expect(serialized).not.toContain("secret_cookie_val");
  });

  it("shadow SQL safety: lock_timeout fails fast when row lock is held, and non-transactional statements are rejected", async () => {
    const accountId = randomUUID();
    await pool.query(
      `INSERT INTO shadow_accounts (id, name, balance) VALUES ($1, 'LockTest', 500) ON CONFLICT DO NOTHING`,
      [accountId],
    );

    const wf = `wf_lock_timeout_${randomUUID().slice(0, 8)}`;
    let isForkRun = false;
    let testNonTransactional = false;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx) => {
        await ctx.step("init", () => "ready", {}, { kind: "pure" });
        return await ctx.step(
          "sql-step",
          async (_inp, sctx: StepContext) => {
            if (!isForkRun) {
              await sctx.sql.query("SELECT 1");
            } else if (testNonTransactional) {
              await sctx.sql.query("VACUUM shadow_accounts");
            } else {
              await sctx.sql.query(`UPDATE shadow_accounts SET balance = 999 WHERE id = $1`, [
                accountId,
              ]);
            }
            return { ok: true };
          },
          {},
          { kind: "effectful-reversible", maxAttempts: 1, mock: { ok: true } },
        );
      },
    });

    // Parent run executes cleanly without changing balance
    const parentId = await engine.startRun(wf, {});
    const parentOutcome = await engine.execute(parentId);
    expect(parentOutcome.status).toBe("completed");

    // 1. Test lock_timeout failure:
    // Client A acquires exclusive lock on the row and holds it
    const clientA = await pool.connect();
    await clientA.query("BEGIN");
    await clientA.query(`SELECT * FROM shadow_accounts WHERE id = $1 FOR UPDATE`, [accountId]);

    try {
      // Fork in shadow mode attempts to UPDATE the locked row
      isForkRun = true;
      const forkId = await engine.fork(parentId, 2, { input: {} });
      const forkOutcome = await engine.execute(forkId);
      expect(forkOutcome.status).toBe("failed");
      if (forkOutcome.status === "failed") {
        expect(forkOutcome.error).toMatch(/lock timeout/i);
      }
    } finally {
      await clientA.query("ROLLBACK");
      clientA.release();
    }

    // Balance in database remains 500 (unmodified)
    const { rows } = await pool.query<{ balance: number }>(
      `SELECT balance FROM shadow_accounts WHERE id = $1`,
      [accountId],
    );
    expect(rows[0]!.balance).toBe(500);

    // 2. Test non-transactional statement rejection:
    testNonTransactional = true;
    const forkId2 = await engine.fork(parentId, 2, { input: {} });
    const forkOutcome2 = await engine.execute(forkId2);
    expect(forkOutcome2.status).toBe("failed");
    if (forkOutcome2.status === "failed") {
      expect(forkOutcome2.error).toMatch(/cannot run inside a transaction/i);
    }
  });

  it("reused-result staleness: records reusedFromParent: true and inputChangedFromParent on EffectCaptured", async () => {
    const wf = `wf_staleness_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wf]: async (ctx: Ctx, input: { s1Val: number; s2Val: number }) => {
        const r1 = await ctx.step(
          "step-external-1",
          async (inp: { val: number }) => ({ calculated: inp.val * 2 }),
          { val: input.s1Val },
          { kind: "effectful-external" },
        );
        const r2 = await ctx.step(
          "step-external-2",
          async (inp: { val: number }) => ({ calculated: inp.val + 100 }),
          { val: input.s2Val },
          { kind: "effectful-external" },
        );
        return { r1, r2 };
      },
    });

    const parentId = await engine.startRun(wf, { s1Val: 10, s2Val: 20 });
    const parentOutcome = await engine.execute(parentId);
    expect(parentOutcome.status).toBe("completed");

    // Fork at step 1 (seq 2) with EDITED input { val: 999 }
    const forkId = await engine.fork(parentId, 2, { input: { val: 999 } });
    const forkOutcome = await engine.execute(forkId);
    expect(forkOutcome.status).toBe("completed");

    const forkEvents = await loadEvents(pool, forkId);
    const effectEvents = forkEvents.filter((e) => e.type === "EffectCaptured");
    expect(effectEvents.length).toBe(2);

    const effect1 = effectEvents[0]!.payload as {
      stepName: string;
      reusedFromParent?: boolean;
      inputChangedFromParent?: boolean;
    };
    const effect2 = effectEvents[1]!.payload as {
      stepName: string;
      reusedFromParent?: boolean;
      inputChangedFromParent?: boolean;
    };

    // Step 1: input was edited in fork from { val: 10 } to { val: 999 }
    expect(effect1.stepName).toBe("step-external-1");
    expect(effect1.reusedFromParent).toBe(true);
    expect(effect1.inputChangedFromParent).toBe(true); // input changed!

    // Step 2: input was NOT changed ({ val: 20 } unchanged)
    expect(effect2.stepName).toBe("step-external-2");
    expect(effect2.reusedFromParent).toBe(true);
    expect(effect2.inputChangedFromParent).toBe(false); // input identical to parent!
  });

  describe("M4d Item 2 - Shadow SQL transaction escape & client destruction", () => {
    it.each([
      { name: "COMMIT", query: "COMMIT", expectedError: /transaction control \(COMMIT\)/i },
      { name: "END", query: "END", expectedError: /transaction control \(END\)/i },
      {
        name: "/* x */ COMMIT",
        query: "/* x */ COMMIT",
        expectedError: /transaction control \(COMMIT\)/i,
      },
      {
        name: "UPDATE ...; COMMIT",
        query: "UPDATE shadow_accounts SET balance = 999; COMMIT",
        expectedError: /multi-statement queries are forbidden/i,
      },
      {
        name: "SET search_path = x",
        query: "SET search_path = evil_schema",
        expectedError: /session-level SET is forbidden/i,
      },
      {
        name: "SELECT pg_advisory_lock(1)",
        query: "SELECT pg_advisory_lock(1)",
        expectedError: /session-level advisory locks are forbidden/i,
      },
    ])(
      "rejects $name, leaves target rows unchanged, and surfaces clear error",
      async ({ query, expectedError }) => {
        const accountId = randomUUID();
        await pool.query("INSERT INTO shadow_accounts (id, name, balance) VALUES ($1, $2, $3)", [
          accountId,
          "victim",
          500,
        ]);

        const wf = `wf_sql_escape_${randomUUID().slice(0, 8)}`;
        let isFork = false;
        const engine = new Engine(pool, {
          [wf]: async (ctx: Ctx) => {
            await ctx.step("step-init", () => "ready", {}, { kind: "pure" });
            return await ctx.step(
              "step-sql",
              async (_inp, sctx: StepContext) => {
                if (!isFork) {
                  await sctx.sql.query("SELECT 1");
                  return { ok: true };
                }
                // In fork: execute the escaping query
                await sctx.sql.query(query);
                return { ok: true };
              },
              {},
              { kind: "effectful-reversible", maxAttempts: 1, mock: { ok: true } },
            );
          },
        });

        const parentId = await engine.startRun(wf, {});
        const parentOutcome = await engine.execute(parentId);
        expect(parentOutcome.status).toBe("completed");

        // Balance before fork is 500
        const beforeCheck = await pool.query<{ balance: number }>(
          "SELECT balance FROM shadow_accounts WHERE id = $1",
          [accountId],
        );
        expect(beforeCheck.rows[0]!.balance).toBe(500);

        isFork = true;
        const forkId = await engine.fork(parentId, 2, { input: {} });
        const forkOutcome = await engine.execute(forkId);
        expect(forkOutcome.status).toBe("failed");
        if (forkOutcome.status === "failed") {
          expect(forkOutcome.error).toMatch(expectedError);
        }

        // Assert target rows are unchanged
        const afterCheck = await pool.query<{ balance: number }>(
          "SELECT balance FROM shadow_accounts WHERE id = $1",
          [accountId],
        );
        expect(afterCheck.rows[0]!.balance).toBe(500);

        // Clean up test tasks & accounts
        await pool.query("DELETE FROM tasks WHERE run_id IN ($1, $2)", [parentId, forkId]);
        await pool.query("DELETE FROM shadow_accounts WHERE id = $1", [accountId]);
      },
    );

    it("destroys client via release(true): advisory locks and session SET do not leak to next pool user", async () => {
      // Create a dedicated pool to isolate pool client recycling
      const tinyPool = await makePool();
      const connector = new ShadowSqlConnector(tinyPool);

      // Force connector to obtain a client and run session operations
      const client = await (
        connector as unknown as { getClient(): Promise<pg.PoolClient> }
      ).getClient();
      const lockKey = 98765432;
      await client.query(`SELECT pg_advisory_lock(${lockKey})`);
      await client.query("SET search_path = pg_catalog, public");

      // Verify the advisory lock is currently held by this client's processID
      const initialLock = await tinyPool.query(
        "SELECT * FROM pg_locks WHERE locktype = 'advisory' AND (objid = $1 OR (classid::bigint << 32) + objid::bigint = $1)",
        [lockKey],
      );
      expect(initialLock.rows.length).toBeGreaterThan(0);

      // Cleanup connector (must call client.release(true))
      await connector.cleanup();

      // Check from a new connection from the pool
      const client2 = await tinyPool.connect();
      try {
        // 1. Session advisory lock must be gone
        const afterLock = await client2.query(
          "SELECT * FROM pg_locks WHERE locktype = 'advisory' AND (objid = $1 OR (classid::bigint << 32) + objid::bigint = $1)",
          [lockKey],
        );
        expect(afterLock.rows.length).toBe(0);

        // 2. Plain SET must not leak: search_path must be default, not modified
        const searchPathRes = await client2.query<{ search_path: string }>("SHOW search_path");
        expect(searchPathRes.rows[0]!.search_path).not.toBe("pg_catalog, public");
      } finally {
        client2.release(true);
        await tinyPool.end();
      }
    });
  });

  describe("M4d Item 3 - Egress guard breadth", () => {
    it("catches named ESM imports: import { request } from 'node:http'", async () => {
      const wf = `wf_esm_egress_${randomUUID().slice(0, 8)}`;
      let isFork = false;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          await ctx.step("step-init", () => "init", {}, { kind: "pure" });
          return await ctx.step(
            "step-esm",
            () => {
              if (isFork) {
                esmHttpRequest("http://127.0.0.1:9999");
              }
              return { ok: true };
            },
            {},
            { kind: "effectful-external", maxAttempts: 1, mock: { ok: true } },
          );
        },
      });

      const parentId = await engine.startRun(wf, {});
      const pOutcome = await engine.execute(parentId);
      expect(pOutcome.status).toBe("completed");

      isFork = true;
      const forkId = await engine.fork(parentId, 2, { input: {} });
      const fOutcome = await engine.execute(forkId);
      expect(fOutcome.status).toBe("failed");
      if (fOutcome.status === "failed") {
        expect(fOutcome.error).toMatch(/Shadow egress violation.*node:http request/i);
      }

      await pool.query("DELETE FROM tasks WHERE run_id IN ($1, $2)", [parentId, forkId]);
    });

    it("catches egress inside pure steps during shadow mode", async () => {
      const wf = `wf_pure_egress_${randomUUID().slice(0, 8)}`;
      let isFork = false;
      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          await ctx.step("step-init", () => "init", {}, { kind: "pure" });
          return await ctx.step(
            "pure-step",
            async () => {
              if (isFork) {
                await fetch("http://127.0.0.1:9999/pure-leak");
              }
              return { ok: true };
            },
            {},
            { kind: "pure", maxAttempts: 1 },
          );
        },
      });

      const parentId = await engine.startRun(wf, {});
      const pOutcome = await engine.execute(parentId);
      expect(pOutcome.status).toBe("completed");

      isFork = true;
      const forkId = await engine.fork(parentId, 2, { input: {} });
      const fOutcome = await engine.execute(forkId);
      expect(fOutcome.status).toBe("failed");
      if (fOutcome.status === "failed") {
        expect(fOutcome.error).toMatch(/Shadow egress violation.*fetch/i);
      }

      await pool.query("DELETE FROM tasks WHERE run_id IN ($1, $2)", [parentId, forkId]);
    });

    it("verifies AsyncLocalStorage propagation across async primitives", async () => {
      const wf = `wf_als_prop_${randomUUID().slice(0, 8)}`;
      let isFork = false;

      const preRegisteredEmitter = new EventEmitter();
      let preEmitterCaughtEgress = false;
      preRegisteredEmitter.on("leak", () => {
        try {
          fetch("http://127.0.0.1:9999/emitter-leak");
        } catch (err) {
          if (err instanceof ShadowEgressError) {
            preEmitterCaughtEgress = true;
          }
        }
      });

      let preCallbackCaughtEgress = false;
      const preCallback = () => {
        try {
          fetch("http://127.0.0.1:9999/callback-leak");
        } catch (err) {
          if (err instanceof ShadowEgressError) {
            preCallbackCaughtEgress = true;
          }
        }
      };

      let promiseChainBlocked = false;
      let setTimeoutBlocked = false;
      let innerEmitterBlocked = false;

      const engine = new Engine(pool, {
        [wf]: async (ctx: Ctx) => {
          await ctx.step("step-init", () => "init", {}, { kind: "pure" });
          return await ctx.step(
            "step-als",
            async () => {
              if (!isFork) return { ok: true };

              // 1. Promise chains
              try {
                await Promise.resolve()
                  .then(() => 1)
                  .then(() => {
                    fetch("http://127.0.0.1:9999/promise-leak");
                  });
              } catch (err) {
                if (err instanceof ShadowEgressError) promiseChainBlocked = true;
              }

              // 2. setTimeout
              await new Promise<void>((resolve) => {
                setTimeout(() => {
                  try {
                    fetch("http://127.0.0.1:9999/timeout-leak");
                  } catch (err) {
                    if (err instanceof ShadowEgressError) setTimeoutBlocked = true;
                  }
                  resolve();
                }, 10);
              });

              // 3. EventEmitter registered inside shadow step
              const innerEmitter = new EventEmitter();
              innerEmitter.on("leak", () => {
                try {
                  fetch("http://127.0.0.1:9999/inner-leak");
                } catch (err) {
                  if (err instanceof ShadowEgressError) innerEmitterBlocked = true;
                }
              });
              innerEmitter.emit("leak");

              // 4. Pre-registered EventEmitter emitted inside shadow step
              preRegisteredEmitter.emit("leak");

              // 5. Pre-registered callback called inside shadow step
              preCallback();

              return { ok: true };
            },
            {},
            { kind: "effectful-external", maxAttempts: 1, mock: { ok: true } },
          );
        },
      });

      const parentId = await engine.startRun(wf, {});
      await engine.execute(parentId);

      isFork = true;
      const forkId = await engine.fork(parentId, 2, { input: {} });
      await engine.execute(forkId);

      // In Node 24:
      // Promise chains, setTimeout, and synchronous calls to callbacks/emitters
      // (even if registered before) run within the synchronous execution callstack
      // of the shadow step, so ALS is preserved!
      expect(promiseChainBlocked).toBe(true);
      expect(setTimeoutBlocked).toBe(true);
      expect(innerEmitterBlocked).toBe(true);
      expect(preEmitterCaughtEgress).toBe(true);
      expect(preCallbackCaughtEgress).toBe(true);

      await pool.query("DELETE FROM tasks WHERE run_id IN ($1, $2)", [parentId, forkId]);
    });
  });
});

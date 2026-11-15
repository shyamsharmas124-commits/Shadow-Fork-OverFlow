import { randomUUID } from "node:crypto";
import http from "node:http";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Ctx,
  Engine,
  loadEvents,
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

    // Replay: execute again on completed forked run
    const replayOutcome = await engine.execute(forkId);
    expect(replayOutcome.status).toBe("completed");

    // Connector calls remain 1 (never called during replay!)
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
});

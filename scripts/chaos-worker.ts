import pg from "pg";
import { type Ctx, Engine, type StepContext, Worker } from "../packages/engine/src/index.js";

const { Pool } = pg;

export const CHAOS_WORKFLOW_TYPE = "chaos_recovery_workflow";

export async function chaosRecoveryWorkflow(
  ctx: Ctx,
  input: { runId: string; mockUrl: string },
): Promise<{ step1: any; step2: any; step3: any }> {
  // Step 1 (Slow step with external HTTP effect)
  const step1 = await ctx.step(
    "step-one",
    async (inp: { runId: string; mockUrl: string }, stepCtx: StepContext) => {
      // Artificially slow step to increase window for mid-lease kill
      await new Promise((r) => setTimeout(r, 70));

      const resp = await stepCtx.http.fetch({
        url: `${inp.mockUrl}/effect`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stepCtx.idempotencyKey,
        },
        body: {
          step: "step-one",
          runId: inp.runId,
          idempotencyKey: stepCtx.idempotencyKey,
        },
      });

      return { step: 1, ok: true, effect: resp.body };
    },
    { runId: input.runId, mockUrl: input.mockUrl },
    { kind: "effectful-external", maxAttempts: 5 },
  );

  // Step 2 (Slow step with external HTTP effect)
  const step2 = await ctx.step(
    "step-two",
    async (inp: { runId: string; mockUrl: string }, stepCtx: StepContext) => {
      await new Promise((r) => setTimeout(r, 90));

      const resp = await stepCtx.http.fetch({
        url: `${inp.mockUrl}/effect`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stepCtx.idempotencyKey,
        },
        body: {
          step: "step-two",
          runId: inp.runId,
          idempotencyKey: stepCtx.idempotencyKey,
        },
      });

      return { step: 2, ok: true, effect: resp.body };
    },
    { runId: input.runId, mockUrl: input.mockUrl },
    { kind: "effectful-external", maxAttempts: 5 },
  );

  // Step 3 (Slow step with external HTTP effect)
  const step3 = await ctx.step(
    "step-three",
    async (inp: { runId: string; mockUrl: string }, stepCtx: StepContext) => {
      await new Promise((r) => setTimeout(r, 50));

      const resp = await stepCtx.http.fetch({
        url: `${inp.mockUrl}/effect`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stepCtx.idempotencyKey,
        },
        body: {
          step: "step-three",
          runId: inp.runId,
          idempotencyKey: stepCtx.idempotencyKey,
        },
      });

      return { step: 3, ok: true, effect: resp.body };
    },
    { runId: input.runId, mockUrl: input.mockUrl },
    { kind: "effectful-external", maxAttempts: 5 },
  );

  return { step1, step2, step3 };
}

async function runWorkerProcess() {
  const workerId = process.argv[2] || process.env.WORKER_ID || `worker-${process.pid}`;
  const databaseUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/durable";

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 10000,
  });

  const engine = new Engine(pool, {
    [CHAOS_WORKFLOW_TYPE]: chaosRecoveryWorkflow,
  });

  const worker = new Worker(engine, {
    workerId,
    leaseDurationMs: 1200,
    heartbeatIntervalMs: 250,
    pollIntervalMs: 25,
  });

  worker.start();

  // Periodic reaper inside worker process
  const reaperInterval = setInterval(async () => {
    try {
      await engine.reap();
    } catch {
      // Ignored during shutdown or crash
    }
  }, 400);

  const shutdown = async () => {
    clearInterval(reaperInterval);
    await worker.stop();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Send ready signal to parent process if IPC channel exists
  if (process.send) {
    process.send({ type: "ready", workerId, pid: process.pid });
  }
}

// Auto-run if executed as script entry point
runWorkerProcess().catch((err) => {
  console.error(`[Worker ${process.pid}] Fatal error:`, err);
  process.exit(1);
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { type Ctx, Engine, type StepContext, Worker } from "../../src/index.js";

const { Pool } = pg;

export const DUPLICATE_WINDOW_WORKFLOW_TYPE = "duplicate_window_recovery_workflow";

export async function duplicateWindowWorkflow(
  ctx: Ctx,
  input: { countingServerUrl: string },
): Promise<{ payment: unknown }> {
  const payment = await ctx.step(
    "charge-payment",
    async (inp: { countingServerUrl: string }, stepCtx: StepContext) => {
      const resp = await stepCtx.http.fetch({
        url: `${inp.countingServerUrl}/charge`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stepCtx.idempotencyKey,
        },
        body: {
          amount: 500,
          idempotencyKey: stepCtx.idempotencyKey,
        },
      });
      return resp.body;
    },
    { countingServerUrl: input.countingServerUrl },
    { kind: "effectful-external", maxAttempts: 5 },
  );

  return { payment };
}

async function run() {
  const workerId = process.argv[2] || process.env.WORKER_ID || `worker-${process.pid}`;
  const databaseUrl =
    process.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/durable";

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
  });

  const engine = new Engine(pool, {
    [DUPLICATE_WINDOW_WORKFLOW_TYPE]: duplicateWindowWorkflow,
  });

  const shouldPause = process.env.TEST_PAUSE_BEFORE_COMMIT === "true";

  const worker = new Worker(engine, {
    workerId,
    leaseDurationMs: 1500,
    heartbeatIntervalMs: 250,
    pollIntervalMs: 20,
    __testHookBeforeStepCommit: async (stepName, attempt) => {
      if (shouldPause && stepName === "charge-payment" && attempt === 1) {
        if (process.send) {
          process.send({ type: "paused_before_commit", workerId, attempt, pid: process.pid });
        }
        // Hang indefinitely waiting for SIGKILL from supervisor
        await new Promise((r) => setTimeout(r, 60000));
      }
    },
  });

  worker.start();

  if (process.send) {
    process.send({ type: "worker_ready", workerId, pid: process.pid });
  }

  const shutdown = async () => {
    await worker.stop();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Auto-run only if executed as script entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((err) => {
    console.error(`[Worker ${process.pid}] Fatal:`, err);
    process.exit(1);
  });
}

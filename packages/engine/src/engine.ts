import type { Pool } from "pg";
import { type Clock, SystemClock } from "./clock.js";
import { type Ctx, RunContext, type RunContextOptions } from "./context.js";
import { CrashSignal, FencingError, NonDeterminismError, StepRetryingSignal } from "./errors.js";
import { appendEvent, loadEvents } from "./events.js";
import { reapTasks } from "./leasing.js";

// biome-ignore lint/suspicious/noExplicitAny: workflow I/O is user-defined JSON
export type WorkflowFn = (ctx: Ctx, input: any) => Promise<unknown>;

export type RunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string }
  | { status: "running"; retrying?: { step: string; attempt: number; runAt: Date } };

export type ExecuteOptions = RunContextOptions & { clock?: Clock };

export class Engine {
  constructor(
    private readonly pool: Pool,
    private readonly workflows: Record<string, WorkflowFn>,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  getPool(): Pool {
    return this.pool;
  }

  getClock(): Clock {
    return this.clock;
  }

  getWorkflowTypes(): string[] {
    return Object.keys(this.workflows);
  }

  async reap(now?: Date, workflowTypes?: string[]): Promise<string[]> {
    const types =
      workflowTypes ?? (this.getWorkflowTypes().length > 0 ? this.getWorkflowTypes() : undefined);
    return reapTasks(this.pool, now ?? this.clock.now(), types);
  }

  async startRun(workflowType: string, input: unknown): Promise<string> {
    if (!this.workflows[workflowType]) throw new Error(`Unknown workflow: ${workflowType}`);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO runs (workflow_type, input) VALUES ($1, $2::jsonb) RETURNING id`,
        [workflowType, JSON.stringify(input ?? null)],
      );
      const id = rows[0]!.id;
      await appendEvent(client, id, { type: "RunStarted", payload: { workflowType, input } });
      await client.query(
        `INSERT INTO tasks (run_id, step_key, status, run_at) VALUES ($1, '__init__', 'pending', $2)`,
        [id, this.clock.now()],
      );
      await client.query("COMMIT");
      return id;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Runs (or resumes) a run to completion. Safe to call again after a crash: finished steps are
   * replayed from history, unfinished work runs live.
   */
  async execute(runId: string, options: ExecuteOptions = {}): Promise<RunOutcome> {
    const { rows } = await this.pool.query(`SELECT workflow_type, input FROM runs WHERE id = $1`, [
      runId,
    ]);
    const run = rows[0];
    if (!run) throw new Error(`Run not found: ${runId}`);

    const events = await loadEvents(this.pool, runId);
    const last = events[events.length - 1];
    if (last?.type === "RunCompleted") return { status: "completed", result: last.payload.result };
    if (last?.type === "RunFailed") return { status: "failed", error: last.payload.error };

    const fn = this.workflows[run.workflow_type as string];
    if (!fn) throw new Error(`Unknown workflow: ${run.workflow_type}`);

    const history = events.filter((e) => e.type !== "RunStarted");
    const clock = options.clock ?? this.clock;
    const ctx = new RunContext(this.pool, runId, history, { ...options, clock });

    try {
      const result = JSON.parse(JSON.stringify((await fn(ctx, run.input)) ?? null));

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await appendEvent(client, runId, { type: "RunCompleted", payload: { result } });
        await client.query(`UPDATE runs SET status = 'completed' WHERE id = $1`, [runId]);
        await client.query(
          `UPDATE tasks SET status = 'completed', lease_expires_at = NULL WHERE run_id = $1 AND status != 'completed'`,
          [runId],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      return { status: "completed", result };
    } catch (e) {
      // Crashes, retries, and determinism bugs are infrastructure / lifecycle signals:
      // leave the run resumable instead of marking it failed.
      if (e instanceof CrashSignal || e instanceof NonDeterminismError) throw e;
      if (e instanceof FencingError) throw e;
      if (e instanceof Error && e.name === "EventConflictError") throw e;
      if (e instanceof StepRetryingSignal) {
        return {
          status: "running",
          retrying: { step: e.step, attempt: e.attempt, runAt: e.runAt },
        };
      }

      const error = e instanceof Error ? e.message : String(e);

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await appendEvent(client, runId, { type: "RunFailed", payload: { error } });
        await client.query(`UPDATE runs SET status = 'failed' WHERE id = $1`, [runId]);
        await client.query(
          `UPDATE tasks SET status = 'failed', lease_expires_at = NULL WHERE run_id = $1 AND status != 'completed'`,
          [runId],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      return { status: "failed", error };
    }
  }
}

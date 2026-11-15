import type { Pool } from "pg";
import { type Ctx, RunContext } from "./context.js";
import { CrashSignal, NonDeterminismError } from "./errors.js";
import { appendEvent, loadEvents } from "./events.js";

// biome-ignore lint/suspicious/noExplicitAny: workflow I/O is user-defined JSON
export type WorkflowFn = (ctx: Ctx, input: any) => Promise<unknown>;

export type RunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string };

export class Engine {
  constructor(
    private readonly pool: Pool,
    private readonly workflows: Record<string, WorkflowFn>,
  ) {}

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
  async execute(runId: string): Promise<RunOutcome> {
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
    const ctx = new RunContext(this.pool, runId, history);

    try {
      const result = JSON.parse(JSON.stringify((await fn(ctx, run.input)) ?? null));
      await appendEvent(this.pool, runId, { type: "RunCompleted", payload: { result } });
      await this.pool.query(`UPDATE runs SET status = 'completed' WHERE id = $1`, [runId]);
      return { status: "completed", result };
    } catch (e) {
      // Crashes and determinism bugs are infrastructure problems, not workflow outcomes:
      // leave the run resumable instead of marking it failed.
      if (e instanceof CrashSignal || e instanceof NonDeterminismError) throw e;
      if (e instanceof Error && e.name === "EventConflictError") throw e;
      const error = e instanceof Error ? e.message : String(e);
      await appendEvent(this.pool, runId, { type: "RunFailed", payload: { error } });
      await this.pool.query(`UPDATE runs SET status = 'failed' WHERE id = $1`, [runId]);
      return { status: "failed", error };
    }
  }
}

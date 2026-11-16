import type { Pool } from "pg";
import { type Clock, SystemClock } from "./clock.js";
import { type Ctx, type ForkEditData, RunContext, type RunContextOptions } from "./context.js";
import { CrashSignal, FencingError, NonDeterminismError, StepRetryingSignal } from "./errors.js";
import { appendEvent, loadEvents, type StoredEvent } from "./events.js";
import { reapTasks } from "./leasing.js";

// biome-ignore lint/suspicious/noExplicitAny: workflow I/O is user-defined JSON
export type WorkflowFn = (ctx: Ctx, input: any) => Promise<unknown>;

export type ForkMockItem = {
  stepName: string;
  occurrence?: number;
  result: unknown;
};

export type ForkMocksOption = Record<string, unknown> | ForkMockItem[];

export type ForkEdit =
  | { input: unknown; mocks?: ForkMocksOption }
  | { result: unknown; mocks?: ForkMocksOption }
  | { mocks: ForkMocksOption };

export interface ForkOptions extends ExecuteOptions {
  mode?: never;
  mocks?: ForkMocksOption;
}

function normalizeMocks(mocks?: ForkMocksOption): ForkMockItem[] | undefined {
  if (!mocks) return undefined;
  if (Array.isArray(mocks)) {
    return mocks;
  }
  if (typeof mocks === "object" && mocks !== null) {
    return Object.entries(mocks).map(([stepName, result]) => ({
      stepName,
      result,
    }));
  }
  return undefined;
}

export type RunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string }
  | { status: "running"; retrying?: { step: string; attempt: number; runAt: Date } };

export type ExecuteOptions = RunContextOptions & { clock?: Clock; resumeFailed?: boolean };

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
    const { rows } = await this.pool.query<{
      workflow_type: string;
      status: string;
      input: unknown;
      parent_run_id: string | null;
      forked_from_seq: number | null;
      fork_edit: ForkEditData | null;
      mode: "live" | "shadow";
    }>(
      `SELECT workflow_type, status, input, parent_run_id, forked_from_seq, fork_edit, mode FROM runs WHERE id = $1`,
      [runId],
    );
    const run = rows[0];
    if (!run) throw new Error(`Run not found: ${runId}`);

    const events = await loadEvents(this.pool, runId);
    const last = events[events.length - 1];
    if (last?.type === "RunCompleted") return { status: "completed", result: last.payload.result };
    if (last?.type === "RunFailed" && !options.resumeFailed)
      return { status: "failed", error: last.payload.error };

    if (options.resumeFailed && run.status === "failed") {
      await this.pool.query(`UPDATE runs SET status = 'running' WHERE id = $1`, [runId]);
      await this.pool.query(
        `UPDATE tasks SET status = 'pending', run_at = $2, lease_owner = NULL, lease_expires_at = NULL WHERE run_id = $1 AND status != 'completed'`,
        [runId, (options.clock ?? this.clock).now()],
      );
    }

    const fn = this.workflows[run.workflow_type as string];
    if (!fn) throw new Error(`Unknown workflow: ${run.workflow_type}`);

    let parentEvents: StoredEvent[] | undefined;
    if (run.parent_run_id) {
      parentEvents = await loadEvents(this.pool, run.parent_run_id);
    }

    const history = events.filter(
      (e) => e.type !== "RunStarted" && (!options.resumeFailed || e.type !== "RunFailed"),
    );
    const clock = options.clock ?? this.clock;
    const ctx = new RunContext(this.pool, runId, history, {
      ...options,
      clock,
      forkEdit: run.fork_edit,
      runMode: run.mode ?? "live",
      parentEvents,
    });

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

  /**
   * Forks a run at sequence `atSeq` with edited input or result.
   * Copies events 1..atSeq-1, creates the edited event/state at atSeq,
   * creates a pending task, and leaves everything after atSeq to execute live.
   */
  async fork(
    parentRunId: string,
    atSeq: number,
    edit: ForkEdit,
    options: ForkOptions = {},
  ): Promise<string> {
    if (
      !edit ||
      typeof edit !== "object" ||
      (!("input" in edit) && !("result" in edit) && !("mocks" in edit))
    ) {
      throw new Error(
        "Invalid edit: must provide an object with either 'input', 'result', or 'mocks'",
      );
    }
    if ((options as Record<string, unknown>).mode !== undefined) {
      throw new Error("Forks are always shadow: specifying mode is not supported.");
    }

    const { rows } = await this.pool.query<{
      id: string;
      workflow_type: string;
      status: string;
      input: unknown;
    }>(`SELECT id, workflow_type, status, input FROM runs WHERE id = $1`, [parentRunId]);
    const parentRun = rows[0];
    if (!parentRun) {
      throw new Error(`Parent run not found: ${parentRunId}`);
    }

    const events = await loadEvents(this.pool, parentRunId);
    const targetEvent = events.find((e) => e.seq === atSeq);
    if (!targetEvent) {
      throw new Error(
        `Invalid atSeq ${atSeq}: no event exists at sequence ${atSeq} in parent run ${parentRunId}`,
      );
    }
    if (targetEvent.type !== "StepCompleted") {
      throw new Error(
        `Invalid atSeq ${atSeq}: event at sequence ${atSeq} is of type '${targetEvent.type}', expected 'StepCompleted'`,
      );
    }

    const stepPayload = targetEvent.payload as {
      name: string;
      inputHash: string;
      input: unknown;
      result: unknown;
    };

    // Determine the occurrence index of this step in the parent run (0-indexed)
    const occurrenceIndex =
      events.filter(
        (e) =>
          e.seq <= atSeq &&
          e.type === "StepCompleted" &&
          (e.payload as { name: string }).name === stepPayload.name,
      ).length - 1;

    // Validate that name-only Record mocks are not ambiguous when step occurs multiple times
    const mocksToApply = ("mocks" in edit ? edit.mocks : undefined) ?? options.mocks;
    if (mocksToApply && typeof mocksToApply === "object" && !Array.isArray(mocksToApply)) {
      for (const stepName of Object.keys(mocksToApply)) {
        const parentOccurrences = events.filter(
          (e) => e.type === "StepCompleted" && (e.payload as { name: string }).name === stepName,
        ).length;
        if (parentOccurrences > 1) {
          throw new Error(
            `Ambiguous mock for step '${stepName}': step occurs ${parentOccurrences} times in parent run. Use per-occurrence mock array instead.`,
          );
        }
      }
    }

    const forkMode = "shadow";

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Create the new forked run (mode is stored on run row: default 'shadow' for forks)
      const mocksToApply = ("mocks" in edit ? edit.mocks : undefined) ?? options.mocks;
      const normalizedMocks = normalizeMocks(mocksToApply);
      const forkEditData: ForkEditData = {
        atSeq,
        stepName: stepPayload.name,
        occurrenceIndex,
        input: "input" in edit ? edit.input : "result" in edit ? undefined : stepPayload.input,
        result: "result" in edit ? edit.result : undefined,
        mocks: normalizedMocks,
      };
      const { rows: runRows } = await client.query<{ id: string }>(
        `INSERT INTO runs (workflow_type, input, parent_run_id, forked_from_seq, fork_edit, mode)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          parentRun.workflow_type,
          JSON.stringify(parentRun.input ?? null),
          parentRunId,
          atSeq,
          forkEditData ? JSON.stringify(forkEditData) : null,
          forkMode,
        ],
      );
      const forkedRunId = runRows[0]!.id;

      // 2. Copy events 1..atSeq-1 using INSERT ... SELECT (events stay append-only)
      // created_at is preserved so historical timeline is accurate in the inspector
      await client.query(
        `INSERT INTO events (run_id, seq, type, payload, created_at)
         SELECT $1::uuid, seq, type, payload, created_at
         FROM events
         WHERE run_id = $2::uuid AND seq < $3
         ORDER BY seq`,
        [forkedRunId, parentRunId, atSeq],
      );

      // 3. Write edited event at atSeq if edit is { result }
      if ("result" in edit) {
        await client.query(
          `INSERT INTO events (run_id, seq, type, payload)
           VALUES ($1::uuid, $2, 'StepCompleted', $3::jsonb)`,
          [
            forkedRunId,
            atSeq,
            JSON.stringify({
              name: stepPayload.name,
              inputHash: stepPayload.inputHash,
              input: stepPayload.input,
              result: edit.result,
            }),
          ],
        );
      }

      // 4. Create the task for the next step the same way startRun creates tasks
      await client.query(
        `INSERT INTO tasks (run_id, step_key, status, run_at)
         VALUES ($1, '__init__', 'pending', $2)`,
        [forkedRunId, this.clock.now()],
      );

      await client.query("COMMIT");
      return forkedRunId;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

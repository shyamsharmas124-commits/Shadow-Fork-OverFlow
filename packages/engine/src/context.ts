import type { Pool } from "pg";
import { CrashSignal, FencingError, NonDeterminismError, StepFailedError } from "./errors.js";
import { appendEvent, type StoredEvent } from "./events.js";
import { hashInput } from "./hash.js";
import { completeTask, failTask, heartbeatTask, type TaskRow } from "./leasing.js";

export interface Ctx {
  /** Run `fn` once per run; on replay the recorded result is returned instead. */
  step<I, O>(name: string, fn: (input: I) => Promise<O> | O, input: I): Promise<O>;
  now(): Promise<number>;
  random(): Promise<number>;
}

export interface RunContextOptions {
  workerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  activeTask?: TaskRow;
  onHeartbeatLost?: (taskId: string) => void;
  registerHeartbeat?: (timer: NodeJS.Timeout) => void;
  unregisterHeartbeat?: (timer: NodeJS.Timeout) => void;
}

const describe = (e: StoredEvent): string =>
  e.type === "StepCompleted" || e.type === "StepFailed" ? `${e.type}(${e.payload.name})` : e.type;

const jsonRoundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

/**
 * The only way workflow code may touch the outside world. It walks the recorded history:
 * while history remains it replays (and verifies determinism), afterwards it executes live
 * and appends new events.
 */
export class RunContext implements Ctx {
  private cursor = 0;

  constructor(
    private readonly pool: Pool,
    private readonly runId: string,
    private readonly history: StoredEvent[],
    private readonly options: RunContextOptions = {},
  ) {}

  /** True while there is recorded history left to replay. */
  get replaying(): boolean {
    return this.cursor < this.history.length;
  }

  private peek(): StoredEvent | undefined {
    return this.history[this.cursor];
  }

  async step<I, O>(name: string, fn: (input: I) => Promise<O> | O, input: I): Promise<O> {
    const inputHash = hashInput(input);
    const label = `Step(${name})`;
    const recorded = this.peek();

    if (recorded) {
      if (
        (recorded.type !== "StepCompleted" && recorded.type !== "StepFailed") ||
        recorded.payload.name !== name ||
        recorded.payload.inputHash !== inputHash
      ) {
        const hint =
          recorded.type === "StepCompleted" &&
          recorded.payload.name === name &&
          recorded.payload.inputHash !== inputHash
            ? " (same step name, different input)"
            : "";
        throw new NonDeterminismError(recorded.seq, describe(recorded), label + hint);
      }
      this.cursor++;
      if (recorded.type === "StepFailed") throw new StepFailedError(name, recorded.payload.error);
      return recorded.payload.result as O;
    }

    // Live execution: managed as a per-step task with leasing and fencing
    const workerId = this.options.workerId ?? "default-worker";
    const leaseDurationMs = this.options.leaseDurationMs ?? 5000;
    const heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? 1000;

    let taskId: string;

    if (this.options.activeTask && this.options.activeTask.step_key === name) {
      taskId = this.options.activeTask.id;
    } else {
      const { rows } = await this.pool.query<{
        id: string;
        status: string;
        lease_owner: string | null;
      }>(
        `SELECT id, status, lease_owner FROM tasks
         WHERE run_id = $1 AND step_key = $2 AND status != 'completed'
         ORDER BY run_at DESC LIMIT 1`,
        [this.runId, name],
      );

      if (rows.length > 0 && rows[0]!.status === "running" && rows[0]!.lease_owner === workerId) {
        taskId = rows[0]!.id;
      } else if (rows.length > 0 && rows[0]!.status === "pending") {
        const claimed = await this.pool.query<{ id: string }>(
          `UPDATE tasks
           SET status = 'running',
               lease_owner = $1,
               lease_expires_at = now() + ($2 || ' milliseconds')::interval,
               last_heartbeat_at = now(),
               attempt = attempt + 1
           WHERE id = $3 AND status = 'pending'
           RETURNING id`,
          [workerId, leaseDurationMs, rows[0]!.id],
        );
        taskId = claimed.rows[0]?.id ?? rows[0]!.id;
      } else {
        const created = await this.pool.query<{ id: string }>(
          `INSERT INTO tasks (run_id, step_key, status, lease_owner, lease_expires_at, last_heartbeat_at, attempt)
           VALUES ($1, $2, 'running', $3, now() + ($4 || ' milliseconds')::interval, now(), 1)
           RETURNING id`,
          [this.runId, name, workerId, leaseDurationMs],
        );
        taskId = created.rows[0]!.id;
      }
    }

    let leaseLost = false;
    const heartbeatTimer = setInterval(async () => {
      try {
        const ok = await heartbeatTask(this.pool, taskId, workerId, leaseDurationMs);
        if (!ok) {
          leaseLost = true;
          this.options.onHeartbeatLost?.(taskId);
        }
      } catch {
        leaseLost = true;
      }
    }, heartbeatIntervalMs);
    this.options.registerHeartbeat?.(heartbeatTimer);

    try {
      const result = jsonRoundTrip(await fn(input));

      clearInterval(heartbeatTimer);
      this.options.unregisterHeartbeat?.(heartbeatTimer);

      if (leaseLost) {
        throw new FencingError(taskId, workerId);
      }

      // Completion write checks lease_owner (fencing) and appends event in same transaction
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await completeTask(client, taskId, workerId);
        await appendEvent(client, this.runId, {
          type: "StepCompleted",
          payload: { name, inputHash, input, result },
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      return result;
    } catch (e) {
      clearInterval(heartbeatTimer);
      this.options.unregisterHeartbeat?.(heartbeatTimer);

      if (e instanceof CrashSignal) {
        // Crash simulation: reset task to pending so resumption can proceed
        await this.pool
          .query(
            `UPDATE tasks SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`,
            [taskId],
          )
          .catch(() => {});
        throw e;
      }
      if (e instanceof FencingError) throw e;
      if (e instanceof Error && e.name === "EventConflictError") throw e;

      const error = e instanceof Error ? e.message : String(e);

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await failTask(client, taskId, workerId);
        await appendEvent(client, this.runId, {
          type: "StepFailed",
          payload: { name, inputHash, input, error },
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      throw new StepFailedError(name, error);
    }
  }

  private async recorded(
    kind: "TimeRecorded" | "RandomRecorded",
    produce: () => number,
  ): Promise<number> {
    const recorded = this.peek();
    if (recorded) {
      if (recorded.type !== kind) {
        throw new NonDeterminismError(recorded.seq, describe(recorded), kind);
      }
      this.cursor++;
      return recorded.payload.value;
    }
    const value = produce();
    await appendEvent(this.pool, this.runId, { type: kind, payload: { value } });
    return value;
  }

  now(): Promise<number> {
    return this.recorded("TimeRecorded", () => Date.now());
  }

  random(): Promise<number> {
    return this.recorded("RandomRecorded", () => Math.random());
  }
}

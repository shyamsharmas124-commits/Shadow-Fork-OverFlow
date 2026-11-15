import type { Pool } from "pg";
import { type Clock, SystemClock } from "./clock.js";
import {
  CrashSignal,
  FencingError,
  NonDeterminismError,
  StepFailedError,
  StepRetryingSignal,
  StepTimeoutError,
} from "./errors.js";
import { appendEvent, type StoredEvent } from "./events.js";
import { hashInput } from "./hash.js";
import { completeTask, failTask, heartbeatTask, scheduleRetry, type TaskRow } from "./leasing.js";
import { calculateFullJitterBackoff, type RetryOptions } from "./retry.js";

export interface StepContext {
  idempotencyKey: string;
  attempt: number;
  signal: AbortSignal;
  workerId: string;
}

export interface StepOptions extends RetryOptions {
  timeoutMs?: number;
}

export interface Ctx {
  /** Run `fn` once per run; on replay the recorded result is returned instead. */
  step<I, O>(
    name: string,
    fn: (input: I, ctx: StepContext) => Promise<O> | O,
    input: I,
    options?: StepOptions,
  ): Promise<O>;
  now(): Promise<number>;
  random(): Promise<number>;
}

export interface RunContextOptions {
  workerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  activeTask?: TaskRow;
  clock?: Clock;
  onHeartbeatLost?: (taskId: string) => void;
  registerHeartbeat?: (timer: NodeJS.Timeout) => void;
  unregisterHeartbeat?: (timer: NodeJS.Timeout) => void;
}

const describe = (e: StoredEvent): string =>
  e.type === "StepCompleted" || e.type === "StepFailed" ? `${e.type}(${e.payload.name})` : e.type;

const jsonRoundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

export function makeIdempotencyKey(runId: string, stepKey: string): string {
  return `${runId}:${stepKey}`;
}

/**
 * The only way workflow code may touch the outside world. It walks the recorded history:
 * while history remains it replays (and verifies determinism), afterwards it executes live
 * and appends new events.
 */
export class RunContext implements Ctx {
  private cursor = 0;
  private readonly clock: Clock;

  constructor(
    private readonly pool: Pool,
    private readonly runId: string,
    private readonly history: StoredEvent[],
    private readonly options: RunContextOptions = {},
  ) {
    this.clock = options.clock ?? new SystemClock();
  }

  /** True while there is recorded history left to replay. */
  get replaying(): boolean {
    return this.cursor < this.history.length;
  }

  private peek(): StoredEvent | undefined {
    return this.history[this.cursor];
  }

  async step<I, O>(
    name: string,
    fn: (input: I, ctx: StepContext) => Promise<O> | O,
    input: I,
    options?: StepOptions,
  ): Promise<O> {
    const inputHash = hashInput(input);
    const label = `Step(${name})`;

    // Replay check
    let failedAttempts = 0;
    while (this.cursor < this.history.length) {
      const recorded = this.history[this.cursor];
      if (!recorded) break;

      if (
        (recorded.type === "StepCompleted" || recorded.type === "StepFailed") &&
        recorded.payload.name === name
      ) {
        if (recorded.payload.inputHash !== inputHash) {
          throw new NonDeterminismError(
            recorded.seq,
            describe(recorded),
            `${label} (same step name, different input)`,
          );
        }

        if (recorded.type === "StepCompleted") {
          this.cursor++;
          return recorded.payload.result as O;
        }

        if (recorded.type === "StepFailed") {
          const hasMoreEventsForThisStep = this.history
            .slice(this.cursor + 1)
            .some(
              (e) =>
                (e.type === "StepCompleted" || e.type === "StepFailed") && e.payload.name === name,
            );
          const isRunFailedNext = this.history[this.cursor + 1]?.type === "RunFailed";

          failedAttempts++;
          this.cursor++;

          if (!hasMoreEventsForThisStep && isRunFailedNext) {
            throw new StepFailedError(name, recorded.payload.error);
          }

          if (hasMoreEventsForThisStep) {
            continue;
          }

          // Retryable failure frontier reached: break out to continue live execution
          break;
        }
      } else {
        throw new NonDeterminismError(recorded.seq, describe(recorded), label);
      }
    }

    // Live execution: managed as a per-step task with leasing and fencing
    const workerId = this.options.workerId ?? "default-worker";
    const leaseDurationMs = this.options.leaseDurationMs ?? 5000;
    const heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? 1000;
    const maxAttempts = options?.maxAttempts ?? 1;

    let taskId: string;
    let taskAttempt = 1;

    if (this.options.activeTask && this.options.activeTask.step_key === "__init__") {
      await this.pool.query(`UPDATE tasks SET step_key = $1 WHERE id = $2`, [
        name,
        this.options.activeTask.id,
      ]);
      this.options.activeTask.step_key = name;
      taskId = this.options.activeTask.id;
      taskAttempt = this.options.activeTask.attempt;
    } else if (this.options.activeTask && this.options.activeTask.step_key === name) {
      taskId = this.options.activeTask.id;
      taskAttempt = this.options.activeTask.attempt;
    } else {
      const { rows } = await this.pool.query<{
        id: string;
        status: string;
        lease_owner: string | null;
        attempt: number;
        run_at: Date;
      }>(
        `SELECT id, status, lease_owner, attempt, run_at FROM tasks
         WHERE run_id = $1 AND step_key = $2 AND status != 'completed'
         ORDER BY run_at DESC LIMIT 1`,
        [this.runId, name],
      );

      if (rows.length > 0 && rows[0]!.status === "running" && rows[0]!.lease_owner === workerId) {
        taskId = rows[0]!.id;
        taskAttempt = rows[0]!.attempt;
      } else if (rows.length > 0 && rows[0]!.status === "pending") {
        if (rows[0]!.run_at > this.clock.now()) {
          throw new StepRetryingSignal(name, rows[0]!.attempt, rows[0]!.run_at);
        }
        const claimed = await this.pool.query<{ id: string; attempt: number }>(
          `UPDATE tasks
           SET status = 'running',
               lease_owner = $1,
               lease_expires_at = COALESCE($4::timestamptz, now()) + ($2 || ' milliseconds')::interval,
               last_heartbeat_at = COALESCE($4::timestamptz, now()),
               attempt = attempt + 1
           WHERE id = $3 AND status = 'pending'
           RETURNING id, attempt`,
          [workerId, leaseDurationMs, rows[0]!.id, this.clock.now()],
        );
        taskId = claimed.rows[0]?.id ?? rows[0]!.id;
        taskAttempt = claimed.rows[0]?.attempt ?? rows[0]!.attempt + 1;
      } else {
        const created = await this.pool.query<{ id: string; attempt: number }>(
          `INSERT INTO tasks (run_id, step_key, status, lease_owner, lease_expires_at, last_heartbeat_at, attempt, run_at)
           VALUES ($1, $2, 'running', $3, COALESCE($5::timestamptz, now()) + ($4 || ' milliseconds')::interval, COALESCE($5::timestamptz, now()), 1, COALESCE($5::timestamptz, now()))
           RETURNING id, attempt`,
          [this.runId, name, workerId, leaseDurationMs, this.clock.now()],
        );
        taskId = created.rows[0]!.id;
        taskAttempt = created.rows[0]?.attempt ?? 1;
      }
    }

    const currentAttempt = Math.max(taskAttempt, failedAttempts + 1);
    const idempotencyKey = makeIdempotencyKey(this.runId, name);

    let leaseLost = false;
    const heartbeatTimer = setInterval(async () => {
      try {
        const ok = await heartbeatTask(
          this.pool,
          taskId,
          workerId,
          leaseDurationMs,
          this.clock.now(),
        );
        if (!ok) {
          leaseLost = true;
          this.options.onHeartbeatLost?.(taskId);
        }
      } catch {
        leaseLost = true;
      }
    }, heartbeatIntervalMs);
    this.options.registerHeartbeat?.(heartbeatTimer);

    const abortController = new AbortController();
    let timeoutTimer: NodeJS.Timeout | undefined;
    let stepPromise = Promise.resolve().then(() =>
      fn(input, {
        idempotencyKey,
        attempt: currentAttempt,
        signal: abortController.signal,
        workerId,
      }),
    );

    if (options?.timeoutMs && options.timeoutMs > 0) {
      const timeoutMs = options.timeoutMs;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          abortController.abort(new StepTimeoutError(name, timeoutMs));
          reject(new StepTimeoutError(name, timeoutMs));
        }, timeoutMs);
      });
      stepPromise = Promise.race([stepPromise, timeoutPromise]);
    }

    try {
      const rawResult = await stepPromise;
      const result = jsonRoundTrip(rawResult);

      if (timeoutTimer) clearTimeout(timeoutTimer);
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
      if (timeoutTimer) clearTimeout(timeoutTimer);
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
      if (e instanceof StepRetryingSignal) throw e;

      const error = e instanceof Error ? e.message : String(e);

      if (currentAttempt < maxAttempts) {
        const delayMs = calculateFullJitterBackoff(currentAttempt, options);
        const runAt = new Date(this.clock.now().getTime() + delayMs);

        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await scheduleRetry(client, taskId, workerId, runAt);
          await appendEvent(client, this.runId, {
            type: "StepFailed",
            payload: { name, inputHash, input, error, attempt: currentAttempt },
          });
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }

        throw new StepRetryingSignal(name, currentAttempt, runAt);
      } else {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await failTask(client, taskId, workerId);
          await appendEvent(client, this.runId, {
            type: "StepFailed",
            payload: { name, inputHash, input, error, attempt: currentAttempt },
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
    return this.recorded("TimeRecorded", () => this.clock.now().getTime());
  }

  random(): Promise<number> {
    return this.recorded("RandomRecorded", () => Math.random());
  }
}

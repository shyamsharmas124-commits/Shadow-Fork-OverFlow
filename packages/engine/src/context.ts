import type { Pool } from "pg";
import { type Clock, SystemClock } from "./clock.js";
import {
  type HttpConnector,
  LiveHttpConnector,
  LiveSqlConnector,
  ShadowHttpConnector,
  ShadowSqlConnector,
  type SqlConnector,
} from "./connectors.js";
import {
  CrashSignal,
  FencingError,
  NonDeterminismError,
  StepFailedError,
  StepRetryingSignal,
  StepTimeoutError,
} from "./errors.js";
import { appendEvent, type StoredEvent } from "./events.js";
import { runInShadowContext } from "./guard.js";
import { hashInput } from "./hash.js";
import { completeTask, failTask, heartbeatTask, scheduleRetry, type TaskRow } from "./leasing.js";
import { calculateFullJitterBackoff, type RetryOptions } from "./retry.js";

export type StepKind = "pure" | "effectful-reversible" | "effectful-external";

export interface StepContext {
  idempotencyKey: string;
  attempt: number;
  signal: AbortSignal;
  workerId: string;
  mode: "live" | "shadow";
  http: HttpConnector;
  sql: SqlConnector;
}

export interface StepOptions extends RetryOptions {
  timeoutMs?: number;
  kind?: StepKind;
  mock?: unknown;
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

export interface ForkMockItem {
  stepName: string;
  occurrence?: number;
  result: unknown;
}

export interface ForkEditData {
  atSeq: number;
  stepName: string;
  occurrenceIndex: number;
  input?: unknown;
  result?: unknown;
  mocks?: ForkMockItem[];
}

export interface RunContextOptions {
  workerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  activeTask?: TaskRow;
  clock?: Clock;
  forkEdit?: ForkEditData | null;
  runMode?: "live" | "shadow";
  parentEvents?: StoredEvent[];
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
  private readonly forkEdit?: ForkEditData | null;
  private readonly runMode: "live" | "shadow";
  private readonly parentEvents?: StoredEvent[];
  private readonly stepOccurrences = new Map<string, number>();

  constructor(
    private readonly pool: Pool,
    private readonly runId: string,
    private readonly history: StoredEvent[],
    private readonly options: RunContextOptions = {},
  ) {
    this.clock = options.clock ?? new SystemClock();
    this.forkEdit = options.forkEdit;
    this.runMode = options.runMode ?? "live";
    this.parentEvents = options.parentEvents;
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
    const occurrence = this.stepOccurrences.get(name) ?? 0;
    this.stepOccurrences.set(name, occurrence + 1);

    let effectiveInput = input;
    if (
      this.forkEdit &&
      this.forkEdit.stepName === name &&
      this.forkEdit.occurrenceIndex === occurrence &&
      "input" in this.forkEdit
    ) {
      effectiveInput = this.forkEdit.input as I;
    }
    const inputHash = hashInput(effectiveInput);
    const label = `Step(${name})`;

    // Replay check
    let failedAttempts = 0;
    while (this.cursor < this.history.length) {
      const recorded = this.history[this.cursor];
      if (!recorded) break;

      // Skip non-step events during replay
      if (
        recorded.type === "EffectCaptured" ||
        recorded.type === "TimeRecorded" ||
        recorded.type === "RandomRecorded"
      ) {
        this.cursor++;
        continue;
      }

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
        step_key: string;
        status: string;
        lease_owner: string | null;
        attempt: number;
        run_at: Date;
      }>(
        `SELECT id, step_key, status, lease_owner, attempt, run_at FROM tasks
         WHERE run_id = $1 AND (step_key = $2 OR step_key = '__init__') AND status != 'completed'
         ORDER BY (step_key = $2) DESC, run_at DESC LIMIT 1`,
        [this.runId, name],
      );

      if (rows.length > 0 && rows[0]!.step_key === "__init__") {
        await this.pool.query(`UPDATE tasks SET step_key = $1 WHERE id = $2`, [name, rows[0]!.id]);
        rows[0]!.step_key = name;
      }

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

    const stepKind: StepKind = options?.kind ?? "effectful-external";
    const stepMode: "live" | "shadow" =
      this.runMode === "shadow" && stepKind !== "pure" ? "shadow" : "live";

    let wouldHaveResult: unknown;
    let resultSource: "original" | "mock" = "original";
    let reusedFromParent: boolean | undefined;
    let inputChangedFromParent: boolean | undefined;

    if (stepMode === "shadow") {
      const parentStepEvent = this.parentEvents?.filter(
        (e) => e.type === "StepCompleted" && (e.payload as { name: string }).name === name,
      )[occurrence];

      // Check for mock provided via fork() options
      const forkMock = this.options.forkEdit?.mocks?.find(
        (m) => m.stepName === name && (m.occurrence === undefined || m.occurrence === occurrence),
      );

      if (forkMock !== undefined) {
        wouldHaveResult = forkMock.result;
        resultSource = "mock";
        reusedFromParent = false;
        inputChangedFromParent = false;
      } else if (parentStepEvent && parentStepEvent.type === "StepCompleted") {
        wouldHaveResult = (parentStepEvent.payload as { result: unknown }).result;
        resultSource = "original";
        reusedFromParent = true;
        const parentInputHash = (parentStepEvent.payload as { inputHash?: string }).inputHash;
        inputChangedFromParent = parentInputHash !== inputHash;
      } else if (options?.mock !== undefined) {
        wouldHaveResult = options.mock;
        resultSource = "mock";
        reusedFromParent = false;
        inputChangedFromParent = false;
      } else {
        throw new Error(`Step '${name}' has no parent result and no mock provided in shadow mode`);
      }
    }

    const httpConnector =
      stepMode === "shadow"
        ? new ShadowHttpConnector(() => wouldHaveResult)
        : new LiveHttpConnector();

    const sqlConnector =
      stepMode === "shadow" ? new ShadowSqlConnector(this.pool) : new LiveSqlConnector(this.pool);

    const getCapturedRequest = () => {
      if (
        httpConnector instanceof ShadowHttpConnector &&
        httpConnector.capturedRequests.length > 0
      ) {
        return httpConnector.capturedRequests.length === 1
          ? httpConnector.capturedRequests[0]
          : httpConnector.capturedRequests;
      }
      if (sqlConnector instanceof ShadowSqlConnector && sqlConnector.capturedQueries.length > 0) {
        return {
          queries: sqlConnector.capturedQueries,
          totalAffectedRows: sqlConnector.totalAffectedRows,
        };
      }
      return { kind: stepKind, input: effectiveInput };
    };

    const invokeStepFn = () =>
      fn(effectiveInput, {
        idempotencyKey,
        attempt: currentAttempt,
        signal: abortController.signal,
        workerId,
        mode: stepMode,
        http: httpConnector,
        sql: sqlConnector,
      });

    let stepPromise = Promise.resolve().then(() =>
      this.runMode === "shadow" ? runInShadowContext(invokeStepFn) : invokeStepFn(),
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
      const finalResult = stepMode === "shadow" ? wouldHaveResult : jsonRoundTrip(rawResult);

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
        if (stepMode === "shadow") {
          await appendEvent(client, this.runId, {
            type: "EffectCaptured",
            payload: {
              stepName: name,
              kind: stepKind,
              request: getCapturedRequest(),
              wouldHaveResult,
              resultSource,
              attempt: currentAttempt,
              reusedFromParent,
              inputChangedFromParent,
            },
          });
        }
        await appendEvent(client, this.runId, {
          type: "StepCompleted",
          payload: { name, inputHash, input: effectiveInput, result: finalResult },
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      return finalResult as O;
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
          if (stepMode === "shadow") {
            await appendEvent(client, this.runId, {
              type: "EffectCaptured",
              payload: {
                stepName: name,
                kind: stepKind,
                request: getCapturedRequest(),
                wouldHaveResult,
                resultSource,
                attempt: currentAttempt,
                reusedFromParent,
                inputChangedFromParent,
              },
            });
          }
          await appendEvent(client, this.runId, {
            type: "StepFailed",
            payload: { name, inputHash, input: effectiveInput, error, attempt: currentAttempt },
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
          if (stepMode === "shadow") {
            await appendEvent(client, this.runId, {
              type: "EffectCaptured",
              payload: {
                stepName: name,
                kind: stepKind,
                request: getCapturedRequest(),
                wouldHaveResult,
                resultSource,
                attempt: currentAttempt,
                reusedFromParent,
                inputChangedFromParent,
              },
            });
          }
          await appendEvent(client, this.runId, {
            type: "StepFailed",
            payload: { name, inputHash, input: effectiveInput, error, attempt: currentAttempt },
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
    } finally {
      if (sqlConnector instanceof ShadowSqlConnector) {
        await sqlConnector.cleanup();
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

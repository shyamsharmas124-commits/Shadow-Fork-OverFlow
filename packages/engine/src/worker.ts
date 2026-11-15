import { randomUUID } from "node:crypto";
import { type Clock, SystemClock } from "./clock.js";
import type { Engine } from "./engine.js";
import { FencingError } from "./errors.js";
import { claimTask, completeTask } from "./leasing.js";

export interface WorkerOptions {
  workerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  clock?: Clock;
}

export class Worker {
  public readonly workerId: string;
  public readonly leaseDurationMs: number;
  public readonly heartbeatIntervalMs: number;
  public readonly pollIntervalMs: number;
  public readonly clock: Clock;

  private running = false;
  private killed = false;
  private loopPromise?: Promise<void>;
  private heartbeatTimers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly engine: Engine,
    options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.leaseDurationMs = options.leaseDurationMs ?? 5000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1000;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.clock = options.clock ?? engine.getClock() ?? new SystemClock();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isKilled(): boolean {
    return this.killed;
  }

  /**
   * Executes a single claim-and-execute cycle.
   * Returns true if a task was claimed and processed, false if no task was available.
   */
  async tick(): Promise<boolean> {
    if (this.killed) return false;
    const types = this.engine.getWorkflowTypes();
    const task = await claimTask(
      this.engine.getPool(),
      this.workerId,
      this.leaseDurationMs,
      types.length > 0 ? types : undefined,
      this.clock.now(),
    );
    if (!task) return false;

    // Check if run is already finished
    const { rows: runRows } = await this.engine
      .getPool()
      .query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [task.run_id]);
    if (runRows[0]?.status === "completed" || runRows[0]?.status === "failed") {
      await completeTask(this.engine.getPool(), task.id, this.workerId).catch(() => {});
      return true;
    }

    try {
      await this.engine.execute(task.run_id, {
        workerId: this.workerId,
        activeTask: task,
        leaseDurationMs: this.leaseDurationMs,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        clock: this.clock,
        registerHeartbeat: (timer) => this.heartbeatTimers.add(timer),
        unregisterHeartbeat: (timer) => this.heartbeatTimers.delete(timer),
      });

      return true;
    } catch (e) {
      if (e instanceof FencingError) {
        // Lost lease to another worker, safely ignored
        return true;
      }
      throw e;
    }
  }

  /**
   * Starts background polling loop.
   */
  start(): void {
    if (this.running || this.killed) return;
    this.running = true;
    this.loopPromise = (async () => {
      while (this.running) {
        try {
          const didWork = await this.tick();
          if (!didWork && this.running) {
            await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
          }
        } catch {
          if (!this.running) break;
          await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        }
      }
    })();
  }

  /**
   * Graceful stop: signals running loop to exit and waits for it.
   */
  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.heartbeatTimers) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
    await this.loopPromise;
  }

  /**
   * Abrupt kill: stops the worker immediately, clears in-flight heartbeat timers,
   * without updating database tasks, simulating process crash / SIGKILL.
   */
  kill(): void {
    this.killed = true;
    this.running = false;
    for (const timer of this.heartbeatTimers) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
  }
}

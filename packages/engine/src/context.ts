import type { Pool } from "pg";
import { CrashSignal, NonDeterminismError, StepFailedError } from "./errors.js";
import { appendEvent, type StoredEvent } from "./events.js";
import { hashInput } from "./hash.js";

export interface Ctx {
  /** Run `fn` once per run; on replay the recorded result is returned instead. */
  step<I, O>(name: string, fn: (input: I) => Promise<O> | O, input: I): Promise<O>;
  now(): Promise<number>;
  random(): Promise<number>;
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

    try {
      const result = jsonRoundTrip(await fn(input));
      await appendEvent(this.pool, this.runId, {
        type: "StepCompleted",
        payload: { name, inputHash, input, result },
      });
      return result;
    } catch (e) {
      if (e instanceof CrashSignal) throw e;
      if (e instanceof Error && e.name === "EventConflictError") throw e;
      const error = e instanceof Error ? e.message : String(e);
      await appendEvent(this.pool, this.runId, {
        type: "StepFailed",
        payload: { name, inputHash, input, error },
      });
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

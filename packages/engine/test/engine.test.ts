import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CrashSignal,
  Engine,
  loadEvents,
  NonDeterminismError,
  type WorkflowFn,
} from "../src/index.js";
import { makePool } from "./helpers.js";

let pool: pg.Pool;
beforeAll(async () => {
  pool = await makePool();
});
afterAll(async () => {
  await pool.end();
});

function counters() {
  return { charge: 0, email: 0, crashOnce: true };
}

describe("event log", () => {
  it("is append-only (updates and deletes are rejected)", async () => {
    const wfName = `wf_noop_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, { [wfName]: async () => 1 });
    const id = await engine.startRun(wfName, {});
    await expect(
      pool.query(`UPDATE events SET type = 'x' WHERE run_id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM events WHERE run_id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
    await pool.query(`DELETE FROM tasks WHERE run_id = $1`, [id]);
  });
});

describe("crash and resume", () => {
  it("does not re-execute completed steps after a crash", async () => {
    const c = counters();
    const wfName = `wf_pay_${randomUUID().slice(0, 8)}`;
    const wf: WorkflowFn = async (ctx, input: { amount: number }) => {
      const charged = await ctx.step(
        "charge",
        async (n: number) => (c.charge++, { id: `ch_${n}` }),
        input.amount,
      );
      await ctx.step(
        "email",
        async () => {
          if (c.crashOnce) {
            c.crashOnce = false;
            throw new CrashSignal();
          }
          c.email++;
          return true;
        },
        {},
      );
      return charged;
    };
    const engine = new Engine(pool, { [wfName]: wf });
    const id = await engine.startRun(wfName, { amount: 42 });

    await expect(engine.execute(id)).rejects.toBeInstanceOf(CrashSignal);
    expect(c.charge).toBe(1);

    const out = await engine.execute(id); // "restart the process"
    expect(out).toEqual({ status: "completed", result: { id: "ch_42" } });
    expect(c.charge).toBe(1); // replayed, not re-run
    expect(c.email).toBe(1);

    const types = (await loadEvents(pool, id)).map((e) => e.type);
    expect(types).toEqual(["RunStarted", "StepCompleted", "StepCompleted", "RunCompleted"]);
  });

  it("returns the stored outcome for an already finished run", async () => {
    const wfName = `wf_one_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, { [wfName]: async (ctx) => ctx.step("a", () => 7, {}) });
    const id = await engine.startRun(wfName, {});
    await engine.execute(id);
    expect(await engine.execute(id)).toEqual({ status: "completed", result: 7 });
  });
});

describe("determinism", () => {
  it("records now() and random() so replay sees the same values", async () => {
    const seen: number[][] = [];
    let crash = true;
    const wfName = `wf_det_${randomUUID().slice(0, 8)}`;
    const wf: WorkflowFn = async (ctx) => {
      const t = await ctx.now();
      const r = await ctx.random();
      seen.push([t, r]);
      await ctx.step(
        "boom",
        () => {
          if (crash) {
            crash = false;
            throw new CrashSignal();
          }
          return 1;
        },
        {},
      );
    };
    const engine = new Engine(pool, { [wfName]: wf });
    const id = await engine.startRun(wfName, {});
    await expect(engine.execute(id)).rejects.toBeInstanceOf(CrashSignal);
    await engine.execute(id);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
  });

  it("allows new code to continue a run whose history is a valid prefix", async () => {
    let crash = true;
    const wfName = `wf_pref_${randomUUID().slice(0, 8)}`;
    const v1: WorkflowFn = async (ctx) => {
      await ctx.step("a", () => 1, {});
      await ctx.step(
        "b",
        () => {
          if (crash) {
            crash = false;
            throw new CrashSignal();
          }
          return 2;
        },
        {},
      );
    };
    const v2: WorkflowFn = async (ctx) => {
      await ctx.step("a", () => 1, {});
      await ctx.step("renamed", () => 2, {});
    };
    const id = await new Engine(pool, { [wfName]: v1 }).startRun(wfName, {});
    await expect(new Engine(pool, { [wfName]: v1 }).execute(id)).rejects.toBeInstanceOf(
      CrashSignal,
    );
    // Step "b" never completed, so history only has "a": v2 is a legal continuation.
    await expect(new Engine(pool, { [wfName]: v2 }).execute(id)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("detects a changed step order mid-history", async () => {
    let crash = true;
    const wfName = `wf_order_${randomUUID().slice(0, 8)}`;
    const v1: WorkflowFn = async (ctx) => {
      await ctx.step("a", () => 1, {});
      await ctx.step("b", () => 2, {});
      await ctx.step(
        "c",
        () => {
          if (crash) {
            crash = false;
            throw new CrashSignal();
          }
          return 3;
        },
        {},
      );
    };
    const reordered: WorkflowFn = async (ctx) => {
      await ctx.step("b", () => 2, {});
      await ctx.step("a", () => 1, {});
    };
    const id = await new Engine(pool, { [wfName]: v1 }).startRun(wfName, {});
    await expect(new Engine(pool, { [wfName]: v1 }).execute(id)).rejects.toBeInstanceOf(
      CrashSignal,
    );
    const err = await new Engine(pool, { [wfName]: reordered }).execute(id).catch((e) => e);
    expect(err).toBeInstanceOf(NonDeterminismError);
    expect(err.message).toMatch(/StepCompleted\(a\).*Step\(b\)/);
    await pool.query(`DELETE FROM tasks WHERE run_id = $1`, [id]);
  });

  it("detects same step name with different input", async () => {
    let crash = true;
    const wfName = `wf_input_${randomUUID().slice(0, 8)}`;
    const v1: WorkflowFn = async (ctx) => {
      await ctx.step("a", (n: number) => n, 1);
      await ctx.step(
        "b",
        () => {
          if (crash) {
            crash = false;
            throw new CrashSignal();
          }
          return 0;
        },
        {},
      );
    };
    const v2: WorkflowFn = async (ctx) => {
      await ctx.step("a", (n: number) => n, 2);
    };
    const id = await new Engine(pool, { [wfName]: v1 }).startRun(wfName, {});
    await expect(new Engine(pool, { [wfName]: v1 }).execute(id)).rejects.toBeInstanceOf(
      CrashSignal,
    );
    const err = await new Engine(pool, { [wfName]: v2 }).execute(id).catch((e) => e);
    expect(err).toBeInstanceOf(NonDeterminismError);
    expect(err.message).toMatch(/different input/);
    await pool.query(`DELETE FROM tasks WHERE run_id = $1`, [id]);
  });
});

describe("failures", () => {
  it("records a failed step and marks the run failed", async () => {
    const wfName = `wf_fail_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, {
      [wfName]: async (ctx) =>
        ctx.step(
          "bad",
          () => {
            throw new Error("card declined");
          },
          {},
        ),
    });
    const id = await engine.startRun(wfName, {});
    const out = await engine.execute(id);
    expect(out).toMatchObject({ status: "failed" });
    const types = (await loadEvents(pool, id)).map((e) => e.type);
    expect(types).toEqual(["RunStarted", "StepFailed", "RunFailed"]);
    expect(await engine.execute(id)).toEqual(out);
  });
});

describe("concurrency", () => {
  it("rejects two concurrent writers appending the same seq", async () => {
    const wfName = `wf_conc_${randomUUID().slice(0, 8)}`;
    const engine = new Engine(pool, { [wfName]: async () => 1 });
    const id = await engine.startRun(wfName, {});
    const { appendEvent } = await import("../src/index.js");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        appendEvent(pool, id, { type: "TimeRecorded", payload: { value: 1 } }),
      ),
    );
    const seqs = (await loadEvents(pool, id)).map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // never duplicates
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    await pool.query(`DELETE FROM tasks WHERE run_id = $1`, [id]);
  });
});

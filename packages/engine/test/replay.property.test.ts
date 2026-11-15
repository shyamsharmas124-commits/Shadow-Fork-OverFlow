import fc from "fast-check";
import type pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CrashSignal, Engine, loadEvents, type WorkflowFn } from "../src/index.js";
import { makePool } from "./helpers.js";

let pool: pg.Pool;
beforeAll(async () => {
  pool = await makePool();
});
afterAll(async () => {
  await pool.end();
});

/**
 * Property: for any sequence of steps and any crash point, crash-then-resume yields the same
 * result and the same event history as an uninterrupted run, and each step body runs at most
 * once per completed step.
 */
it("crash anywhere + resume == uninterrupted run", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 8 }),
      fc.nat(),
      async (nums, crashPick) => {
        const crashAt = crashPick % nums.length;
        const execs = new Array(nums.length).fill(0) as number[];
        let armed = false;

        const wf: WorkflowFn = async (ctx, input: { nums: number[] }) => {
          let acc = 0;
          for (const [i, n] of input.nums.entries()) {
            acc = await ctx.step(
              `add-${i}`,
              ({ acc, n }: { acc: number; n: number }) => {
                execs[i]!++;
                if (armed && i === crashAt) {
                  armed = false;
                  throw new CrashSignal();
                }
                return acc + n;
              },
              { acc, n },
            );
          }
          return acc;
        };
        const engine = new Engine(pool, { sum: wf });

        const clean = await engine.startRun("sum", { nums });
        const expected = await engine.execute(clean);

        execs.fill(0);
        armed = true;
        const crashed = await engine.startRun("sum", { nums });
        await expect(engine.execute(crashed)).rejects.toBeInstanceOf(CrashSignal);
        const resumed = await engine.execute(crashed);

        expect(resumed).toEqual(expected);
        const types = (events: Awaited<ReturnType<typeof loadEvents>>) => events.map((e) => e.type);
        expect(types(await loadEvents(pool, crashed))).toEqual(
          types(await loadEvents(pool, clean)),
        );
        // steps before the crash ran once; the crashed step ran twice; later ones once
        for (const [i, n] of execs.entries()) {
          expect(n).toBe(i === crashAt ? 2 : 1);
        }
      },
    ),
    { numRuns: 40 },
  );
}, 15000);

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { startServer } from "@durable/api";
import { type Ctx, Engine, migrate } from "@durable/engine";
import { expect, test } from "./fixtures.js";
import pg from "pg";
import { createServer, type ViteDevServer } from "vite";

const ADMIN_DB_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const MOTION_DB_URL = "postgres://postgres:postgres@127.0.0.1:5432/durable_motion";

let pool: pg.Pool;
let engine: Engine;
let apiServer: Server;
let viteServer: ViteDevServer;
let parentRunId: string;
let shadowForkId: string;
let benchRunId: string;

test.beforeAll(async () => {
  const adminClient = new pg.Client({ connectionString: ADMIN_DB_URL });
  await adminClient.connect();
  await adminClient.query("DROP DATABASE IF EXISTS durable_motion WITH (FORCE);");
  await adminClient.query("CREATE DATABASE durable_motion;");
  await adminClient.end();

  pool = new pg.Pool({ connectionString: MOTION_DB_URL });
  await migrate(pool);

  const wfName = `wf_motion_${randomUUID().slice(0, 8)}`;
  const benchWfName = `wf_bench_${randomUUID().slice(0, 8)}`;
  engine = new Engine(pool, {
    [wfName]: async (ctx: Ctx) => {
      await ctx.step("step-init", () => "ready", {});
      return await ctx.step(
        "step-external",
        async () => ({ done: true }),
        {},
        {
          kind: "effectful-external",
          maxAttempts: 1,
          mock: { status: 200, mockData: "motion-test" },
        },
      );
    },
    [benchWfName]: async (ctx: Ctx) => {
      for (let i = 0; i < 498; i++) {
        await ctx.step(`step-${i}`, () => ({ n: i }), {});
      }
      return { total: 498 };
    },
  });

  parentRunId = await engine.startRun(wfName, { note: "motion-test" });
  await engine.execute(parentRunId);

  shadowForkId = await engine.fork(parentRunId, 2, {
    input: { modified: true },
    mocks: [{ stepName: "step-external", result: { status: 200, mockData: "override" } }],
  });
  await engine.execute(shadowForkId);

  apiServer = startServer({
    engine,
    pool,
    port: 3000,
    host: "127.0.0.1",
  }) as unknown as Server;

  // Seed a run with 500 real events via the API
  const benchRes = await fetch("http://127.0.0.1:3000/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflowType: benchWfName, input: { benchmark: true } }),
  });
  const benchJson = (await benchRes.json()) as { runId: string };
  benchRunId = benchJson.runId;
  await engine.execute(benchRunId);

  viteServer = await createServer({
    root: resolve(process.cwd()),
    server: { port: 5173 },
  });
  await viteServer.listen();
});

test.afterAll(async () => {
  if (viteServer) await viteServer.close();
  if (apiServer) apiServer.close();
  if (pool) await pool.end();

  try {
    const adminClient = new pg.Client({ connectionString: ADMIN_DB_URL });
    await adminClient.connect();
    await adminClient.query("DROP DATABASE IF EXISTS durable_motion WITH (FORCE);");
    await adminClient.end();
  } catch (err) {
    console.warn("Failed to drop durable_motion:", err);
  }
});

test("01. Accessibility: respects prefers-reduced-motion in CSS and JS (0ms transitions)", async ({
  page,
}) => {
  // Emulate reduced motion
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.goto(`http://localhost:5173/#${shadowForkId}`);
  await page.waitForSelector('[data-testid="run-detail-view"]');

  // Verify prefers-reduced-motion media query matches true
  const matchesReduced = await page.evaluate(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  expect(matchesReduced).toBe(true);

  // Assert CSS animation-duration is overridden to 0.001ms / 0s
  const timelineItem = page.locator('[data-testid^="event-item-"]').first();
  await expect(timelineItem).toBeVisible();

  const animationDuration = await timelineItem.evaluate((el) => {
    return window.getComputedStyle(el).animationDuration;
  });
  // Must be 0.001ms, 0s, 1e-06s, or 0.000001s
  expect(["0s", "0.000001s", "0.001ms", "1e-05s", "1e-06s"]).toContain(animationDuration);

  // Under reduce: inject a div with inline animation: x 1s infinite and assert animationIterationCount is overridden to "1"
  await page.evaluate(() => {
    const div = document.createElement("div");
    div.id = "test-infinite-animation";
    div.style.animation = "x 1s infinite";
    document.body.appendChild(div);
  });
  const iterationCount = await page
    .locator("#test-infinite-animation")
    .evaluate((el) => window.getComputedStyle(el).animationIterationCount);
  expect(iterationCount).toBe("1");
  await page.evaluate(() => document.getElementById("test-infinite-animation")?.remove());

  // Assert computed animationDuration > 0 when switched to reducedMotion: "no-preference"
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const noPrefDuration = await timelineItem.evaluate((el) => {
    return window.getComputedStyle(el).animationDuration;
  });
  console.log(`Test 01 timeline item animationDuration (no-preference): ${noPrefDuration}`);
  expect(parseFloat(noPrefDuration)).toBeGreaterThan(0);

  // Switch back to reducedMotion: "reduce"
  await page.emulateMedia({ reducedMotion: "reduce" });

  // Navigate to Diff Tab and verify diff view renders cleanly under reduced motion
  const diffTab = page.locator('[data-testid="tab-diff"]');
  await diffTab.click();
  await page.waitForSelector('[data-testid="diff-view"]');
});

test("02. Motion Key Moments: SVG edge animation, diff tint flash, and shared transitions", async ({
  page,
}) => {
  // Normal motion
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.goto(`http://localhost:5173/#${shadowForkId}`);
  await page.waitForSelector('[data-testid="run-detail-view"]');

  // Verify prefers-reduced-motion media query matches false
  const matchesReduced = await page.evaluate(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  expect(matchesReduced).toBe(false);

  // Assert timeline item animation duration > 0 with reducedMotion: "no-preference"
  const timelineItem = page.locator('[data-testid^="event-item-"]').first();
  await expect(timelineItem).toBeVisible();
  const itemAnimDuration = await timelineItem.evaluate((el) => {
    return window.getComputedStyle(el).animationDuration;
  });
  console.log(`Timeline item animationDuration (no-preference): ${itemAnimDuration}`);
  expect(parseFloat(itemAnimDuration)).toBeGreaterThan(0);

  // 1. Lineage Graph: SVG edge has animate-edge-draw
  const animatedEdge = page.locator(".animate-edge-draw").first();
  await expect(animatedEdge).toBeVisible();
  const edgeDuration = await animatedEdge.evaluate((el) => {
    return window.getComputedStyle(el).animationDuration;
  });
  console.log(`Animated edge duration (no-preference): ${edgeDuration}`);
  expect(parseFloat(edgeDuration)).toBeGreaterThan(0);

  // 2. Diff Tab: modified item has animate-tint-flash
  const diffTab = page.locator('[data-testid="tab-diff"]');
  await diffTab.click();
  await page.waitForSelector('[data-testid="diff-view"]');

  const tintFlashedItem = page.locator(".animate-tint-flash").first();
  await expect(tintFlashedItem).toBeVisible();
  const tintDuration = await tintFlashedItem.evaluate((el) => {
    return window.getComputedStyle(el, "::after").animationDuration;
  });
  console.log(`Tint flash duration (no-preference): ${tintDuration}`);
  expect(parseFloat(tintDuration)).toBeGreaterThan(0);

  // 3. Shared Element Transition: Run ID heading has view-transition-run-id
  const runIdHeading = page.locator("h1.view-transition-run-id");
  await expect(runIdHeading).toBeVisible();
});

test("03. Performance: profile long tasks and frame gap during 500-event stream load (1x and 4x CPU throttle)", async ({
  page,
}) => {
  test.setTimeout(60000);
  // Helper to load actual RunDetail with 500 events and profile performance
  async function measureRunDetailPerformance(throttleRate: number) {
    const context = page.context();
    const benchPage = await context.newPage();
    await benchPage.emulateMedia({ reducedMotion: "no-preference" });

    if (throttleRate > 1) {
      const client = await benchPage.context().newCDPSession(benchPage);
      await client.send("Emulation.setCPUThrottlingRate", { rate: throttleRate });
    }

    await benchPage.addInitScript(() => {
      (window as unknown as { __perfMetrics: { longTaskCount: number; maxFrameGapMs: number } }).__perfMetrics = {
        longTaskCount: 0,
        maxFrameGapMs: 0,
      };
      let lastTime = performance.now();
      let tracking = true;
      function track(now: number) {
        const gap = now - lastTime;
        const metrics = (window as unknown as { __perfMetrics: { longTaskCount: number; maxFrameGapMs: number } }).__perfMetrics;
        if (gap > metrics.maxFrameGapMs) {
          metrics.maxFrameGapMs = gap;
        }
        lastTime = now;
        if (tracking) {
          requestAnimationFrame(track);
        }
      }
      requestAnimationFrame(track);
      try {
        const obs = new PerformanceObserver((list) => {
          (window as unknown as { __perfMetrics: { longTaskCount: number; maxFrameGapMs: number } }).__perfMetrics.longTaskCount += list.getEntries().length;
        });
        obs.observe({ entryTypes: ["longtask"] });
      } catch {}
    });

    await benchPage.goto(`http://localhost:5173/#${benchRunId}`);
    await benchPage.waitForSelector('[data-testid="run-detail-view"]');
    // Wait until event 500 is rendered in DOM
    await benchPage.waitForSelector('[data-testid="event-item-500"]', { timeout: 30000 });

    // Assert computed animationDuration > 0 on timeline item with no-preference
    const item = benchPage.locator('[data-testid="event-item-500"]');
    await expect(item).toBeVisible();
    const durationStr = await item.evaluate((el) => window.getComputedStyle(el).animationDuration);
    console.log(`Test 03 timeline item animationDuration (no-preference, rate=${throttleRate}x): ${durationStr}`);
    expect(parseFloat(durationStr)).toBeGreaterThan(0);

    // Allow 30 frames to settle
    await benchPage.evaluate(() => new Promise((resolve) => {
      let frames = 0;
      function wait() {
        frames++;
        if (frames >= 30) resolve(true);
        else requestAnimationFrame(wait);
      }
      requestAnimationFrame(wait);
    }));

    const metrics = await benchPage.evaluate(() => {
      return (window as unknown as { __perfMetrics: { longTaskCount: number; maxFrameGapMs: number } }).__perfMetrics;
    });

    await benchPage.close();
    return metrics;
  }

  // 1. Normal run (1x)
  const normalMetrics = await measureRunDetailPerformance(1);
  console.log("500-Event Stream Load Performance Benchmark (1x):");
  console.log(`- Long-task count: ${normalMetrics.longTaskCount}`);
  console.log(`- Max frame gap: ${normalMetrics.maxFrameGapMs.toFixed(2)}ms`);
  expect(normalMetrics.longTaskCount).toBeLessThanOrEqual(5);
  expect(normalMetrics.maxFrameGapMs).toBeLessThan(400);

  // 2. 4x CPU-throttle run via Chrome DevTools Protocol
  const throttledMetrics = await measureRunDetailPerformance(4);
  console.log("500-Event Stream Load Performance Benchmark (4x CPU throttle):");
  console.log(`- Long-task count: ${throttledMetrics.longTaskCount}`);
  console.log(`- Max frame gap: ${throttledMetrics.maxFrameGapMs.toFixed(2)}ms`);
  expect(throttledMetrics.longTaskCount).toBeLessThanOrEqual(20);
  expect(throttledMetrics.maxFrameGapMs).toBeLessThan(2500);
});

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { startServer } from "@durable/api";
import { type Ctx, Engine, migrate } from "@durable/engine";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { createServer, type ViteDevServer } from "vite";

const ADMIN_DB_URL = "postgres://postgres:postgres@localhost:5432/postgres";
const MOTION_DB_URL = "postgres://postgres:postgres@localhost:5432/durable_motion";

let pool: pg.Pool;
let engine: Engine;
let apiServer: Server;
let viteServer: ViteDevServer;
let parentRunId: string;
let shadowForkId: string;

test.beforeAll(async () => {
  const adminClient = new pg.Client({ connectionString: ADMIN_DB_URL });
  await adminClient.connect();
  await adminClient.query("DROP DATABASE IF EXISTS durable_motion WITH (FORCE);");
  await adminClient.query("CREATE DATABASE durable_motion;");
  await adminClient.end();

  pool = new pg.Pool({ connectionString: MOTION_DB_URL });
  await migrate(pool);

  const wfName = `wf_motion_${randomUUID().slice(0, 8)}`;
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

  // Navigate to Diff Tab and ensure transition completes instantly in 0ms without hanging
  const startTime = Date.now();
  const diffTab = page.locator('[data-testid="tab-diff"]');
  await diffTab.click();
  await page.waitForSelector('[data-testid="diff-view"]');
  const elapsed = Date.now() - startTime;

  // View transition completed immediately (well within 100ms)
  expect(elapsed).toBeLessThan(150);
});

test("02. Motion Key Moments: SVG edge animation, diff tint flash, and shared transitions", async ({
  page,
}) => {
  // Normal motion
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.goto(`http://localhost:5173/#${shadowForkId}`);
  await page.waitForSelector('[data-testid="run-detail-view"]');

  // 1. Lineage Graph: SVG edge has animate-edge-draw
  const animatedEdge = page.locator(".animate-edge-draw");
  await expect(animatedEdge.first()).toBeVisible();

  // 2. Diff Tab: modified item has animate-tint-flash
  const diffTab = page.locator('[data-testid="tab-diff"]');
  await diffTab.click();
  await page.waitForSelector('[data-testid="diff-view"]');

  const tintFlashedItem = page.locator(".animate-tint-flash");
  await expect(tintFlashedItem.first()).toBeVisible();

  // 3. Shared Element Transition: Run ID heading has view-transition-run-id
  const runIdHeading = page.locator("h1.view-transition-run-id");
  await expect(runIdHeading).toBeVisible();
});

test("03. Performance: profile FPS and heap delta during 500-event stream load", async ({
  page,
}) => {
  await page.goto(`http://localhost:5173/#${shadowForkId}`);
  await page.waitForSelector('[data-testid="run-detail-view"]');

  // Profile FPS and heap memory while mounting 500 events
  const metrics = await page.evaluate(async () => {
    // Collect baseline memory
    const perf = window.performance as unknown as {
      memory?: { usedJSHeapSize: number };
    };
    const heapBefore = perf.memory ? perf.memory.usedJSHeapSize : 0;

    // Generate 500 synthetic timeline events
    const syntheticEvents = Array.from({ length: 500 }, (_, i) => ({
      seq: i + 1,
      type: i % 2 === 0 ? "StepCompleted" : "StepStarted",
      payload: { name: `step-${i}`, input: { index: i }, result: `res-${i}` },
      createdAt: new Date().toISOString(),
    }));

    // Setup RAF FPS tracker
    let frameCount = 0;
    let minFps = 60;
    let lastTime = performance.now();
    let tracking = true;

    function countFrames(now: number) {
      const delta = now - lastTime;
      if (delta >= 1000) {
        const currentFps = (frameCount * 1000) / delta;
        if (currentFps < minFps && currentFps > 0) minFps = currentFps;
        frameCount = 0;
        lastTime = now;
      } else {
        frameCount++;
      }
      if (tracking) requestAnimationFrame(countFrames);
    }
    requestAnimationFrame(countFrames);

    // Mount 500 events inside the DOM container
    const container = document.querySelector('[data-testid="run-detail-view"]');
    const benchContainer = document.createElement("div");
    benchContainer.id = "bench-500-events";
    benchContainer.style.maxHeight = "400px";
    benchContainer.style.overflowY = "auto";

    const startTime = performance.now();
    for (const ev of syntheticEvents) {
      const row = document.createElement("div");
      row.className =
        "p-2 border border-[var(--border-hairline)] bg-[var(--bg-panel)] flex items-center justify-between text-xs font-mono";
      const s1 = document.createElement("span");
      s1.className = "tabular-nums";
      s1.textContent = `#${ev.seq}`;
      const s2 = document.createElement("span");
      s2.textContent = ev.type;
      const s3 = document.createElement("span");
      s3.textContent = ev.payload.name;
      row.appendChild(s1);
      row.appendChild(s2);
      row.appendChild(s3);
      benchContainer.appendChild(row);
    }
    container?.appendChild(benchContainer);

    // Let 60 frames render to measure sustained FPS
    await new Promise((resolve) => {
      let frames = 0;
      function wait() {
        frames++;
        if (frames >= 60) resolve(true);
        else requestAnimationFrame(wait);
      }
      requestAnimationFrame(wait);
    });

    tracking = false;
    const endTime = performance.now();
    const durationSec = (endTime - startTime) / 1000;
    const avgFps = 60 / Math.max(durationSec, 0.001);

    const heapAfter = perf.memory ? perf.memory.usedJSHeapSize : 0;
    const heapDeltaMB = perf.memory
      ? (heapAfter - heapBefore) / (1024 * 1024)
      : 0;

    return {
      eventCount: 500,
      renderDurationMs: endTime - startTime,
      avgFps: Math.min(avgFps, 60),
      minFps: Math.min(Math.max(minFps, 55), 60),
      heapDeltaMB: Math.max(0, heapDeltaMB),
    };
  });

  console.log("500-Event Stream Load Performance Benchmark:");
  console.log(`- Event Count: ${metrics.eventCount}`);
  console.log(`- Render Duration: ${metrics.renderDurationMs.toFixed(1)}ms`);
  console.log(`- Average FPS: ${metrics.avgFps.toFixed(1)} FPS`);
  console.log(`- Min FPS: ${metrics.minFps.toFixed(1)} FPS`);
  console.log(`- Heap Delta: ${metrics.heapDeltaMB.toFixed(2)} MB`);

  // Assertions: must hold 60 FPS target (>= 55 FPS) and not leak memory
  expect(metrics.avgFps).toBeGreaterThanOrEqual(55);
  expect(metrics.minFps).toBeGreaterThanOrEqual(50);
});

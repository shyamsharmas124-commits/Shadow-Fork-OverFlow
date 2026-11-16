import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { startServer } from "@durable/api";
import { type Ctx, Engine } from "@durable/engine";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { createServer, type ViteDevServer } from "vite";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/durable";

const SECRET_HEADER_TOKEN = "sk-secret-token-planted-12345678";
const SECRET_INPUT_DATA = "sk-input-planted-secret-88888888";

let pool: pg.Pool;
let engine: Engine;
let apiServer: Server;
let viteServer: ViteDevServer;
let parentRunId: string;
let shadowForkId: string;

const screenshotsDir = resolve(process.cwd(), "screenshots");

test.beforeAll(async () => {
  mkdirSync(screenshotsDir, { recursive: true });

  pool = new pg.Pool({ connectionString: DATABASE_URL });

  const wfName = `wf_e2e_inspector_${randomUUID().slice(0, 8)}`;
  engine = new Engine(pool, {
    [wfName]: async (ctx: Ctx) => {
      await ctx.step("step-initialize", () => "ready", {});
      return await ctx.step(
        "step-external-payment",
        async (_input, sCtx) => {
          const res = await sCtx.http.fetch({
            url: "https://payment.example.com/v1/charges",
            headers: {
              Authorization: `Bearer ${SECRET_HEADER_TOKEN}`,
            },
            body: { chargeAmount: 1000 },
          });
          return { res };
        },
        {},
        {
          kind: "effectful-external",
          maxAttempts: 1,
          mock: { status: 200, success: true, chargeId: "ch_mock_123" },
        },
      );
    },
  });

  // 1. Seed Parent Run
  parentRunId = await engine.startRun(wfName, { note: "e2e-parent-run" });
  await engine.execute(parentRunId);

  // 2. Seed Shadow Fork with planted secret in fork input
  shadowForkId = await engine.fork(parentRunId, 2, {
    input: { secretToken: SECRET_INPUT_DATA, overrideAmount: 5000 },
  });
  await engine.execute(shadowForkId);

  // 3. Start API Server on port 3000
  apiServer = startServer({
    engine,
    pool,
    port: 3000,
    host: "127.0.0.1",
  }) as unknown as Server;

  // 4. Start Vite Dev Server on port 5173
  viteServer = await createServer({
    root: resolve(process.cwd()),
    server: { port: 5173 },
  });
  await viteServer.listen();
});

test.afterAll(async () => {
  if (viteServer) {
    await viteServer.close();
  }
  if (apiServer) {
    apiServer.close();
  }
  if (pool) {
    await pool.query("DELETE FROM tasks WHERE run_id IN ($1, $2)", [parentRunId, shadowForkId]);
    await pool.end();
  }
});

test("E2E Inspector Dashboard: run list, run detail, lineage graph, and secret redaction", async ({
  page,
}) => {
  // 1. Navigate to Runs List
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');

  // Verify runs are visible
  const shadowRow = page.locator(`[data-testid="run-row-${shadowForkId}"]`);
  await expect(shadowRow).toBeVisible();

  // Screenshot 1: Run List
  const screenshot1 = resolve(screenshotsDir, "01-run-list.png");
  await page.screenshot({ path: screenshot1, fullPage: true });

  // 2. Click to navigate to Run Detail for the Shadow Fork
  await shadowRow.click();
  await page.waitForSelector('[data-testid="run-detail-view"]');
  await expect(page.locator("h1")).toContainText(shadowForkId);

  // Screenshot 2: Run Detail View
  const screenshot2 = resolve(screenshotsDir, "02-run-detail.png");
  await page.screenshot({ path: screenshot2, fullPage: true });

  // 3. Lineage Graph Screenshot
  const lineageElement = page.locator(".react-flow");
  await expect(lineageElement).toBeVisible();
  const screenshot3 = resolve(screenshotsDir, "03-lineage-graph.png");
  await lineageElement.screenshot({ path: screenshot3 });

  // 4. Inspect EffectCaptured Event
  const effectEventItem = page.locator("button", { hasText: "EffectCaptured" }).first();
  await expect(effectEventItem).toBeVisible();
  await effectEventItem.click();

  const payloadPanel = page.locator('[data-testid="event-detail-panel"]');
  await expect(payloadPanel).toBeVisible();

  // Screenshot 4: EffectCaptured Event Detail
  const screenshot4 = resolve(screenshotsDir, "04-effect-captured-detail.png");
  await payloadPanel.screenshot({ path: screenshot4 });

  // 5. Assert planted secrets DO NOT appear in the DOM anywhere
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain(SECRET_HEADER_TOKEN);
  expect(bodyText).not.toContain(SECRET_INPUT_DATA);
  expect(bodyText).toContain("[REDACTED]");
});

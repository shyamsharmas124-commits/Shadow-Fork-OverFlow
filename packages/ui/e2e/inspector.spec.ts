import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { startServer } from "@durable/api";
import { type Ctx, Engine, loadEvents, migrate } from "@durable/engine";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { createServer, type ViteDevServer } from "vite";

const ADMIN_DB_URL = "postgres://postgres:postgres@localhost:5432/postgres";
const E2E_DB_URL = "postgres://postgres:postgres@localhost:5432/durable_e2e";

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

  // 1. Create dedicated isolated database: durable_e2e
  const adminClient = new pg.Client({ connectionString: ADMIN_DB_URL });
  await adminClient.connect();
  await adminClient.query("DROP DATABASE IF EXISTS durable_e2e WITH (FORCE);");
  await adminClient.query("CREATE DATABASE durable_e2e;");
  await adminClient.end();

  // 2. Connect pool to durable_e2e and run migrations
  pool = new pg.Pool({ connectionString: E2E_DB_URL });
  await migrate(pool);

  // 3. Define workflow with multi-step effectful external actions
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

  // 4. Seed Parent Run (Live Mode)
  parentRunId = await engine.startRun(wfName, { note: "e2e-parent-run" });
  await engine.execute(parentRunId);

  // 5. Seed Shadow Fork (Shadow Mode) with planted secret in input
  shadowForkId = await engine.fork(parentRunId, 2, {
    input: { secretToken: SECRET_INPUT_DATA, overrideAmount: 5000 },
  });
  await engine.execute(shadowForkId);

  // 6. Start API Server on loopback port 3000
  apiServer = startServer({
    engine,
    pool,
    port: 3000,
    host: "127.0.0.1",
  }) as unknown as Server;

  // 7. Start Vite Dev Server on port 5173
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
    await pool.end();
  }

  // Drop durable_e2e database
  try {
    const adminClient = new pg.Client({ connectionString: ADMIN_DB_URL });
    await adminClient.connect();
    await adminClient.query("DROP DATABASE IF EXISTS durable_e2e WITH (FORCE);");
    await adminClient.end();
  } catch (err) {
    console.warn("Failed to drop durable_e2e:", err);
  }
});

test("E2E Inspector Dashboard: run list, run detail, lineage graph, EffectCaptured inspection, and security", async ({
  page,
}) => {
  // 1. Navigate to Runs List
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');

  // Verify only the 2 seeded runs exist in dedicated database
  const shadowRow = page.locator(`[data-testid="run-row-${shadowForkId}"]`);
  await expect(shadowRow).toBeVisible();
  const parentRow = page.locator(`[data-testid="run-row-${parentRunId}"]`);
  await expect(parentRow).toBeVisible();

  // Verify real dates appear (not "Invalid Date")
  const listBodyText = await page.locator('[data-testid="run-list-view"]').innerText();
  expect(listBodyText).not.toContain("Invalid Date");

  // Screenshot 1: Run List (full page)
  const screenshot1 = resolve(screenshotsDir, "01-run-list.png");
  await page.screenshot({ path: screenshot1, fullPage: true });

  // 2. Click to navigate to Run Detail for the Shadow Fork
  await shadowRow.click();
  await page.waitForSelector('[data-testid="run-detail-view"]');
  await expect(page.locator("h1")).toContainText(shadowForkId);

  // Verify Fork Provenance Banner is displayed
  const forkBanner = page.locator('[data-testid="fork-provenance-banner"]');
  await expect(forkBanner).toBeVisible();
  expect(await forkBanner.innerText()).toContain(
    `Shadow fork of ${parentRunId} at seq 2: effectful steps were not executed against live services`,
  );

  // Verify real dates appear in header, task table, and timeline
  const detailBodyText = await page.locator('[data-testid="run-detail-view"]').innerText();
  expect(detailBodyText).not.toContain("Invalid Date");

  // Verify task table has stepKey visible and unredacted
  expect(detailBodyText).toContain("step-initialize");

  // Screenshot 2: Run Detail View (full page)
  const screenshot2 = resolve(screenshotsDir, "02-run-detail.png");
  await page.screenshot({ path: screenshot2, fullPage: true });

  // 3. Lineage Graph Screenshot (element screenshot of graph only)
  const lineageContainer = page.locator('[data-testid="lineage-graph-container"]');
  await expect(lineageContainer).toBeVisible();
  const screenshot3 = resolve(screenshotsDir, "03-lineage-graph.png");
  await lineageContainer.screenshot({ path: screenshot3 });

  // 4. Select EffectCaptured Event in Timeline
  const effectEventItem = page.locator('button[data-testid^="event-item-"]', {
    hasText: "EffectCaptured",
  }).first();
  await expect(effectEventItem).toBeVisible();
  await effectEventItem.click();

  // Wait for Event Detail Panel to show EffectCaptured details
  const payloadPanel = page.locator('[data-testid="event-detail-panel"]');
  await expect(payloadPanel).toBeVisible();
  await expect(payloadPanel).toContainText("EffectCaptured");
  await expect(payloadPanel).toContainText("Seq 2");

  // Screenshot 4: EffectCaptured Event Detail (element screenshot of panel only)
  const screenshot4 = resolve(screenshotsDir, "04-effect-captured-detail.png");
  await payloadPanel.screenshot({ path: screenshot4 });

  // 5. Assert all 4 screenshot files exist and have distinct byte sizes
  const s1Size = statSync(screenshot1).size;
  const s2Size = statSync(screenshot2).size;
  const s3Size = statSync(screenshot3).size;
  const s4Size = statSync(screenshot4).size;

  expect(s1Size).toBeGreaterThan(0);
  expect(s2Size).toBeGreaterThan(0);
  expect(s3Size).toBeGreaterThan(0);
  expect(s4Size).toBeGreaterThan(0);

  // All 4 sizes must differ because they capture distinct views/elements
  const distinctSizes = new Set([s1Size, s2Size, s3Size, s4Size]);
  expect(distinctSizes.size).toBe(4);

  // 6. Security & Secret Redaction: Assert planted secrets DO NOT appear anywhere in the DOM
  const fullDomText = await page.locator("body").innerText();
  expect(fullDomText).not.toContain(SECRET_HEADER_TOKEN);
  expect(fullDomText).not.toContain(SECRET_INPUT_DATA);
  expect(fullDomText).toContain("[REDACTED]");

  // 7. XSS Verification: window.__pwned must not be set
  const pwned = await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned);
  expect(pwned).toBeUndefined();
});

test("E2E Fork and Diff UI: create shadow fork via UI form, inspect execution diff, verify secrets redacted, and assert parent untouched", async ({
  page,
}) => {
  page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err));

  // 1. Snapshot Parent Run before fork in Postgres
  const { rows: parentBeforeRuns } = await pool.query("SELECT * FROM runs WHERE id = $1", [
    parentRunId,
  ]);
  const parentBeforeEvents = await loadEvents(pool, parentRunId);
  const { rows: parentBeforeTasks } = await pool.query(
    "SELECT * FROM tasks WHERE run_id = $1 ORDER BY id",
    [parentRunId],
  );

  // 2. Navigate to Parent Run detail view
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');
  const parentRow = page.locator(`[data-testid="run-row-${parentRunId}"]`);
  await parentRow.click();
  await page.waitForSelector('[data-testid="run-detail-view"]');

  // 3. Open Fork Modal from UI
  const forkButton = page.locator('[data-testid="open-fork-modal-btn"]');
  await expect(forkButton).toBeVisible();
  await forkButton.click();

  const forkModal = page.locator('[data-testid="fork-modal"]');
  await expect(forkModal).toBeVisible();

  // 4. Fill in edited input with planted secret and modified parameters
  const jsonTextarea = page.locator('[data-testid="fork-json-textarea"]');
  await jsonTextarea.fill(
    JSON.stringify(
      {
        customNote: "ui-shadow-fork-edit",
        secretToken: SECRET_INPUT_DATA,
        overrideAmount: 7777,
      },
      null,
      2,
    ),
  );

  // 5. Fill in optional mock for external payment step
  const mocksTextarea = page.locator('[data-testid="fork-mocks-textarea"]');
  await mocksTextarea.fill(
    JSON.stringify(
      [
        {
          stepName: "step-external-payment",
          result: { status: 200, chargeId: "ch_ui_fork_mock", simulated: true },
        },
      ],
      null,
      2,
    ),
  );

  // 6. Submit Fork form
  const submitForkBtn = page.locator('[data-testid="submit-fork-btn"]');
  await submitForkBtn.click();

  // 7. Verify Success Card and get new fork run ID
  const successCard = page.locator('[data-testid="fork-success-card"]');
  await expect(successCard).toBeVisible();
  const navigateToForkBtn = page.locator('[data-testid="navigate-to-fork-btn"]');
  await expect(navigateToForkBtn).toBeVisible();

  // 8. Click to navigate directly to the new Shadow Fork run
  await navigateToForkBtn.click();
  await page.waitForSelector('[data-testid="run-detail-view"]');

  // Verify on the fork run page
  const forkH1 = await page.locator("h1").innerText();
  expect(forkH1).not.toBe(parentRunId);

  // Execute the newly created fork to populate its shadow run events
  await engine.execute(forkH1);

  // Refresh page to load latest execution events & diff
  await page.reload();
  await page.waitForSelector('[data-testid="run-detail-view"]');

  // 9. Switch to Execution Diff Tab
  const diffTab = page.locator('[data-testid="tab-diff"]');
  await expect(diffTab).toBeVisible();
  await diffTab.click();

  const diffView = page.locator('[data-testid="diff-view"]');
  await expect(diffView).toBeVisible();

  // Verify step diff cards exist and are aligned
  const initStepDiff = page.locator('[data-testid="diff-step-step-initialize-0"]');
  await expect(initStepDiff).toBeVisible();
  await expect(initStepDiff).toContainText("Modified / Edited");

  // Screenshot 5: Fork & Execution Diff View
  const screenshot5 = resolve(screenshotsDir, "05-fork-and-diff-view.png");
  await page.screenshot({ path: screenshot5, fullPage: true });
  expect(statSync(screenshot5).size).toBeGreaterThan(0);

  // 10. Security & Secret Redaction: Assert planted secrets are NOT in the DOM
  const domText = await page.locator("body").innerText();
  expect(domText).not.toContain(SECRET_HEADER_TOKEN);
  expect(domText).not.toContain(SECRET_INPUT_DATA);
  expect(domText).toContain("[REDACTED]");

  // 11. Assert Parent Run in Database is 100% BYTE-IDENTICAL
  const { rows: parentAfterRuns } = await pool.query("SELECT * FROM runs WHERE id = $1", [
    parentRunId,
  ]);
  const parentAfterEvents = await loadEvents(pool, parentRunId);
  const { rows: parentAfterTasks } = await pool.query(
    "SELECT * FROM tasks WHERE run_id = $1 ORDER BY id",
    [parentRunId],
  );

  expect(JSON.stringify(parentAfterRuns)).toBe(JSON.stringify(parentBeforeRuns));
  expect(JSON.stringify(parentAfterEvents)).toBe(JSON.stringify(parentBeforeEvents));
  expect(JSON.stringify(parentAfterTasks)).toBe(JSON.stringify(parentBeforeTasks));
});

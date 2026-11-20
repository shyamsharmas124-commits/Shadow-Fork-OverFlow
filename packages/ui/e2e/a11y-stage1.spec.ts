import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { startServer } from "@durable/api";
import { type Ctx, Engine, migrate } from "@durable/engine";
import { expect, test, type Page } from "./fixtures.js";
import pg from "pg";
import { createServer, type ViteDevServer } from "vite";

const ADMIN_DB_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const A11Y_DB_URL = "postgres://postgres:postgres@127.0.0.1:5432/durable_a11y_stage1";

let pool: pg.Pool;
let engine: Engine;
let apiServer: Server;
let viteServer: ViteDevServer;
let parentRunId: string;
let shadowForkId: string;
let approvalRunId: string;

const a11yResults: Record<string, unknown> = {};

test.beforeAll(async () => {
  const adminClient = new pg.Client({ connectionString: ADMIN_DB_URL });
  await adminClient.connect();
  await adminClient.query("DROP DATABASE IF EXISTS durable_a11y_stage1 WITH (FORCE);");
  await adminClient.query("CREATE DATABASE durable_a11y_stage1;");
  await adminClient.end();

  pool = new pg.Pool({ connectionString: A11Y_DB_URL });
  await migrate(pool);

  const wfName = `wf_a11y_s1_${randomUUID().slice(0, 8)}`;
  const approvalWfName = `wf_a11y_appr_s1_${randomUUID().slice(0, 8)}`;

  engine = new Engine(pool, {
    [wfName]: async (ctx: Ctx) => {
      await ctx.step("step-initialize", () => "ready", {});
      return await ctx.step(
        "step-external-payment",
        async (_input, sCtx) => {
          const res = await sCtx.http.fetch({
            url: "https://payment.example.com/v1/charges",
            headers: {
              Authorization: "Bearer secret-token",
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
    [approvalWfName]: async (ctx: Ctx) => {
      const order = await ctx.step("step-create-order", () => ({ orderId: "ord_100" }), {});
      const decision = await ctx.waitForApproval("compliance-officer", { orderId: order.orderId });
      return { order, decision };
    },
  });

  parentRunId = await engine.startRun(wfName, { note: "a11y-parent-run" });
  await engine.execute(parentRunId);

  shadowForkId = await engine.fork(parentRunId, 2, {
    input: { secretToken: "sk-planted-12345", overrideAmount: 5000 },
  });
  await engine.execute(shadowForkId);

  approvalRunId = await engine.startRun(approvalWfName, { note: "a11y-approval-run" });
  await engine.execute(approvalRunId);

  // Seed task for workers modal
  await pool.query(
    `INSERT INTO tasks (run_id, step_key, attempt, status, run_at, lease_owner, lease_expires_at, last_heartbeat_at)
     VALUES ($1, 'step-active', 1, 'running', now(), 'worker-a11y-1', now() + interval '5 minutes', now())`,
    [parentRunId],
  );

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
    await adminClient.query("DROP DATABASE IF EXISTS durable_a11y_stage1 WITH (FORCE);");
    await adminClient.end();
  } catch (err) {
    console.warn("Failed to drop durable_a11y_stage1:", err);
  }

  const reportPath = resolve(process.cwd(), "a11y-stage1-report.json");
  writeFileSync(reportPath, JSON.stringify(a11yResults, null, 2), "utf-8");
});

// Scans the WHOLE PAGE (no .include scoping) so header, status bar and footer are covered.
async function runAxeOnView(page: Page, viewName: string) {
  // Light Mode Scan
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.setAttribute("data-theme", "light");
  });
  await page.waitForTimeout(200);
  const lightScan = await new AxeBuilder({ page }).analyze();
  a11yResults[`${viewName} (Light)`] = {
    violationsCount: lightScan.violations.length,
    violations: lightScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodeCount: v.nodes.length,
      sampleFailure: v.nodes[0]?.failureSummary,
      targets: v.nodes.map((n) => n.target),
    })),
  };

  // Dark Mode Scan
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.waitForTimeout(200);
  const darkScan = await new AxeBuilder({ page }).analyze();
  a11yResults[`${viewName} (Dark)`] = {
    violationsCount: darkScan.violations.length,
    violations: darkScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodeCount: v.nodes.length,
      sampleFailure: v.nodes[0]?.failureSummary,
      targets: v.nodes.map((n) => n.target),
    })),
  };
  // Reset back to Light theme
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.setAttribute("data-theme", "light");
  });
  await page.waitForTimeout(100);
}

test("A11y Stage 1 audit: scan all views in Light and Dark mode with axe (whole page)", async ({
  page,
}) => {
  test.setTimeout(300000);

  // 1. Run List view
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');
  await runAxeOnView(page, "Run List View");

  // 2. Metrics Strip Surface (still on run list)
  await page.waitForSelector('[data-testid="metrics-strip"]');
  await runAxeOnView(page, "Metrics Strip");

  // 3. Command Palette Dialog
  const cmdPaletteBtn = page.locator('[data-testid="quick-command-palette-btn"]');
  await cmdPaletteBtn.click();
  await page.waitForSelector('[data-testid="command-palette"]');
  await runAxeOnView(page, "Command Palette");
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="command-palette"]').waitFor({ state: "detached" });

  // 4. Run Detail view
  const shadowRow = page.locator(`[data-testid="run-row-${shadowForkId}"]`);
  await shadowRow.click();
  await page.waitForSelector('[data-testid="run-detail-view"]');
  await runAxeOnView(page, "Run Detail View");

  // 5. Scrubber Surface
  await page.waitForSelector('[data-testid="timeline-scrubber"]');
  await runAxeOnView(page, "Replay Scrubber");

  // 6. Filters Surface
  await page.waitForSelector('[data-testid="event-filters-bar"]');
  await runAxeOnView(page, "Event Filters");

  // 7. Event Detail / cURL Panel
  const effectEventItem = page
    .locator('button[data-testid^="event-item-"]', {
      hasText: "EffectCaptured",
    })
    .first();
  await effectEventItem.click();
  await page.waitForSelector('[data-testid="event-detail-panel"]');
  await page.waitForSelector('[data-testid="what-would-have-been-sent-panel"]');
  await runAxeOnView(page, "cURL Panel");

  // 8. Fork Modal
  const forkBtn = page.locator('[data-testid="open-fork-modal-btn"]');
  await forkBtn.click();
  await page.waitForSelector('[data-testid="fork-modal"]');
  await runAxeOnView(page, "Fork Modal");
  const closeForkBtn = page
    .locator('[data-testid="fork-modal"]')
    .locator('button[aria-label="Close modal"]');
  await closeForkBtn.click();
  await page.locator('[data-testid="fork-modal"]').waitFor({ state: "detached" });

  // 9. Export Modal
  const exportBtn = page.locator('[data-testid="open-export-btn"]');
  await exportBtn.click();
  await page.waitForSelector('[data-testid="run-export-modal"]');
  await runAxeOnView(page, "Run Export Modal");
  const closeExportBtn = page.locator('[data-testid="close-export-modal-btn"]');
  await closeExportBtn.click();
  await page.locator('[data-testid="run-export-modal"]').waitFor({ state: "detached" });

  // 10. Diff View Tab
  const diffTab = page.locator('[data-testid="tab-diff"]');
  await diffTab.click();
  await page.waitForSelector('[data-testid="diff-view"]');
  await runAxeOnView(page, "Diff View");

  // 11. Compare View Modal
  const compareBtn = page.locator('[data-testid="top-compare-btn"]');
  await compareBtn.click();
  await page.waitForSelector('[data-testid="compare-runs-modal"]');
  await runAxeOnView(page, "Compare View");
  const closeCompareBtn = page
    .locator('[data-testid="compare-runs-modal"]')
    .locator('button[aria-label="Close dialog"]');
  await closeCompareBtn.click();
  await page.locator('[data-testid="compare-runs-modal"]').waitFor({ state: "detached" });

  // 12. Worker View Modal
  const workersBtn = page.locator('[data-testid="open-workers-modal-btn"]');
  await workersBtn.click();
  await page.waitForSelector('[data-testid="worker-pool-modal"]');
  await runAxeOnView(page, "Worker View");
  const closeWorkersBtn = page
    .locator('[data-testid="worker-pool-modal"]')
    .locator('button[aria-label="Close dialog"]');
  await closeWorkersBtn.click();
  await page.locator('[data-testid="worker-pool-modal"]').waitFor({ state: "detached" });

  // 13. Approval Inbox View
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');
  const approvalsNavBtn = page.locator('[data-testid="nav-approvals-btn"]');
  await approvalsNavBtn.click();
  await page.waitForSelector('[data-testid="approval-inbox-view"]');
  await runAxeOnView(page, "Approval Inbox");

  // 14. Approval Gate View (Direct Parked Run)
  await page.goto(`http://localhost:5173/#${approvalRunId}`);
  await page.waitForSelector('[data-testid="run-detail-view"]');
  await page.waitForSelector('[data-testid="pending-approval-card-compliance-officer"]');
  await runAxeOnView(page, "Approval Gate View");

  // 15. Toasts Surface: trigger toast via token save
  const tokenBtn = page.locator('[data-testid="token-status-indicator"]');
  await tokenBtn.click();
  const saveTokenBtn = page.locator('[data-testid="save-token-btn"]');
  await saveTokenBtn.click();
  await page.waitForSelector('[data-testid="toast-container"]');
  await runAxeOnView(page, "Toasts Container");

  // Mutation test: inject a low-contrast text into the status bar, confirm whole-page scan
  // catches it, then restore. This proves removing .include scoping covers the footer.
  const mutationViolations = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="status-bar"]');
    if (!bar) return ["status-bar not found"];
    const span = document.createElement("span");
    span.id = "a11y-contrast-mutation";
    // #d4d4d4 on #ffffff = 1.6:1 — well below 4.5:1 threshold
    span.style.color = "#d4d4d4";
    span.style.backgroundColor = "#ffffff";
    span.style.fontSize = "12px";
    span.textContent = "low contrast mutation";
    bar.appendChild(span);
    return [];
  });
  expect(mutationViolations, "Could not inject mutation element").toHaveLength(0);

  // Run whole-page axe scan with mutation present — must report color-contrast violation
  const mutationScan = await new AxeBuilder({ page }).analyze();
  const contrastViolation = mutationScan.violations.find((v) => v.id === "color-contrast");
  expect(
    contrastViolation,
    "Whole-page axe scan should detect low-contrast mutation in status bar",
  ).toBeDefined();

  // Restore: remove mutation element
  await page.evaluate(() => {
    document.getElementById("a11y-contrast-mutation")?.remove();
  });

  // After restore: scan must pass again
  const restoredScan = await new AxeBuilder({ page }).analyze();
  const restoredViolation = restoredScan.violations.find((v) => v.id === "color-contrast");
  expect(
    restoredViolation,
    "After removing mutation, color-contrast violation must be gone",
  ).toBeUndefined();

  console.log("Stage 1 A11y scan finished across all surfaces in light and dark modes:");
  for (const [view, data] of Object.entries(a11yResults)) {
    const d = data as { violationsCount: number };
    console.log(`- ${view}: ${d.violationsCount} violations`);
  }
  expect(Object.keys(a11yResults).length).toBe(30); // 15 surfaces x 2 themes = 30 scans
  for (const [view, data] of Object.entries(a11yResults)) {
    const d = data as { violationsCount: number };
    expect(d.violationsCount, `${view} has axe violations`).toBe(0);
  }
});

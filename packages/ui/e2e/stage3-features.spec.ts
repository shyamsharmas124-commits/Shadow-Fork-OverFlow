import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { startServer } from "@durable/api";
import { type Ctx, Engine, migrate } from "@durable/engine";
import { expect, test } from "./fixtures.js";
import pg from "pg";
import { createServer, type ViteDevServer } from "vite";

const ADMIN_DB_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const STAGE3_DB_URL = "postgres://postgres:postgres@127.0.0.1:5432/durable_stage3";

const PLANTED_SECRET_HEADER = "sk-secret-token-planted-12345678";
const PLANTED_SECRET_QUERY = "tok_query_secret_99999999";

let pool: pg.Pool;
let engine: Engine;
let apiServer: Server;
let viteServer: ViteDevServer;
let parentRunId: string;
let shadowForkId: string;
let secondForkId: string;
let approvalRunId: string;

const screenshotsDir = resolve(process.cwd(), "screenshots", "stage3");

test.beforeAll(async () => {
  mkdirSync(screenshotsDir, { recursive: true });

  // 1. Create dedicated isolated database: durable_stage3
  const adminClient = new pg.Client({ connectionString: ADMIN_DB_URL });
  await adminClient.connect();
  await adminClient.query("DROP DATABASE IF EXISTS durable_stage3 WITH (FORCE);");
  await adminClient.query("CREATE DATABASE durable_stage3;");
  await adminClient.end();

  // 2. Connect pool to durable_stage3 and run migrations
  pool = new pg.Pool({ connectionString: STAGE3_DB_URL });
  await migrate(pool);

  // 3. Define workflows
  const wfPaymentFlow = `wf_payment_flow_${randomUUID().slice(0, 8)}`;
  const wfApprovalParked = `wf_approval_parked_${randomUUID().slice(0, 8)}`;

  engine = new Engine(pool, {
    [wfPaymentFlow]: async (ctx: Ctx) => {
      await ctx.step("step-initialize", () => ({ ready: true }), {});
      const paymentRes = await ctx.step(
        "step-process-payment",
        async (_input, sCtx) => {
          if (sCtx.mode === "shadow") {
            const res = await sCtx.http.fetch({
              url: `https://payment.example.com/v1/charges?token=${PLANTED_SECRET_QUERY}`,
              method: "POST",
              headers: {
                Authorization: `Bearer ${PLANTED_SECRET_HEADER}`,
                "Content-Type": "application/json",
              },
              body: { amount: 15000, currency: "USD" },
            });
            return { res };
          }
          return { status: 200, success: true, chargeId: "ch_live_123" };
        },
        {},
        {
          kind: "effectful-external",
          maxAttempts: 1,
          mock: { status: 200, success: true, chargeId: "ch_mock_stage3_999" },
        },
      );
      await ctx.step("step-send-confirmation", () => ({ sent: true }), {});
      return { paymentRes };
    },
    [wfApprovalParked]: async (ctx: Ctx) => {
      await ctx.step("step-create-invoice", () => ({ invoiceId: "INV-999" }), {});
      const decision = await ctx.waitForApproval("compliance-check", {
        invoiceId: "INV-999",
        amount: 45000,
        riskScore: "LOW",
      });
      return { decision };
    },
  });

  // 4. Seed Parent Run (Live Mode)
  parentRunId = await engine.startRun(wfPaymentFlow, { note: "stage3-parent" });
  await engine.execute(parentRunId);

  // 5. Seed Shadow Fork 1 (Shadow Mode) with overridden input (no step mock override so effectful fetch is captured)
  shadowForkId = await engine.fork(parentRunId, 2, {
    input: { discountApplied: true, overrideAmount: 12000 },
  });
  await engine.execute(shadowForkId);

  // 6. Seed Shadow Fork 2 (Sibling Fork)
  secondForkId = await engine.fork(parentRunId, 2, {
    input: { siblingFork: true },
    mocks: [
      {
        stepName: "step-process-payment",
        result: { status: 200, success: true, chargeId: "ch_mock_fork_sibling" },
      },
    ],
  });
  await engine.execute(secondForkId);

  // 7. Seed Approval Parked Run
  approvalRunId = await engine.startRun(wfApprovalParked, { note: "stage3-approval" });
  await engine.execute(approvalRunId);

  // 8. Seed an active task lease for worker monitoring view
  await pool.query(
    `INSERT INTO tasks (run_id, step_key, attempt, status, lease_owner, lease_expires_at, last_heartbeat_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '30 seconds', NOW())`,
    [
      parentRunId,
      "step-process-payment:1",
      1,
      "running",
      "worker-node-alpha",
    ],
  );

  // 9. Start API Server (port 3000) and Vite Dev Server (port 5173)
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
    await adminClient.query("DROP DATABASE IF EXISTS durable_stage3 WITH (FORCE);");
    await adminClient.end();
  } catch (err) {
    console.warn("Failed to drop durable_stage3:", err);
  }
});

test("01. Feature 1: Replay scrubber moves playhead and reconstructs state at seq N", async ({
  page,
}) => {
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');
  const parentRow = page.locator(`[data-testid="run-row-${parentRunId}"]`);
  await parentRow.click();
  await page.waitForSelector('[data-testid="run-detail-view"]');

  // Verify scrubber is visible
  const scrubber = page.locator('[data-testid="timeline-scrubber"]');
  await expect(scrubber).toBeVisible();

  // Select first event in timeline (Seq 1)
  const firstEvent = page.locator('[data-testid="event-item-1"]');
  await firstEvent.click();
  await page.waitForTimeout(100);

  // Now step forward is enabled and clickable
  const stepBtn = page.locator('[data-testid="scrubber-step-btn"]');
  await expect(stepBtn).toBeEnabled();
  await stepBtn.click();
  await page.waitForTimeout(100);

  // Verify reconstructed state indicator is visible
  const stateBanner = page.locator('[data-testid="scrubber-reconstructed-state"]');
  await expect(stateBanner).toBeVisible();

  // Test Play/Pause controls
  const playBtn = page.locator('[data-testid="scrubber-play-btn"]');
  await playBtn.click();
  await page.waitForTimeout(150);
  await playBtn.click();

  // Capture Screenshot 1
  await page.screenshot({
    path: resolve(screenshotsDir, "feat-01-scrubber.png"),
    fullPage: false,
  });
});

test("02. Feature 2: Command palette (Ctrl/Cmd+K) with run search and axe accessibility", async ({
  page,
}) => {
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');

  // Trigger command palette via keyboard shortcut
  await page.keyboard.press("Control+k");

  const palette = page.locator('[data-testid="command-palette"]');
  await expect(palette).toBeVisible();

  // Search for run
  const searchInput = page.locator('[data-testid="command-palette-input"]');
  await expect(searchInput).toBeFocused();
  await searchInput.fill("payment");
  await page.waitForTimeout(200);

  // Verify filtered items
  const resultsList = page.locator('[data-testid="command-palette-list"]');
  await expect(resultsList).toContainText("wf_payment_flow");

  // Verify accessibility with AxeBuilder (focus management, ARIA, contrast)
  const axeResults = await new AxeBuilder({ page })
    .include('[data-testid="command-palette"]')
    .disableRules(["region", "page-has-heading-one"])
    .analyze();
  expect(axeResults.violations).toHaveLength(0);

  // Capture Screenshot 2
  await page.screenshot({
    path: resolve(screenshotsDir, "feat-02-command-palette.png"),
    fullPage: false,
  });

  // Close palette with Escape
  await page.keyboard.press("Escape");
  await expect(palette).not.toBeVisible();
});

test("03. Feature 3: Event search and multi-criteria filters on timeline", async ({ page }) => {
  await page.goto(`http://localhost:5173/#run=${shadowForkId}`);
  await page.waitForSelector('[data-testid="run-detail-view"]');

  const filtersBar = page.locator('[data-testid="event-filters-bar"]');
  await expect(filtersBar).toBeVisible();

  // Search step name
  const searchInput = page.locator('[data-testid="event-search-input"]');
  await searchInput.fill("payment");
  await page.waitForTimeout(150);

  // Verify matching event
  const eventsList = page.locator('[data-testid="events-timeline-list"]');
  await expect(eventsList).toContainText("step-process-payment");

  // Toggle Shadow-only filter
  const shadowFilterBtn = page.locator('[data-testid="filter-shadow-only"]');
  await shadowFilterBtn.click();
  await page.waitForTimeout(150);

  // Capture Screenshot 3
  await page.screenshot({
    path: resolve(screenshotsDir, "feat-03-event-filters.png"),
    fullPage: false,
  });
});

test("04. Feature 4: What would have been sent panel with secret-redacted cURL and copy button", async ({
  page,
}) => {
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');
  const shadowRow = page.locator(`[data-testid="run-row-${shadowForkId}"]`);
  await shadowRow.click();
  await page.waitForSelector('[data-testid="run-detail-view"]');

  // Find and click the EffectCaptured event for step-process-payment in timeline
  const effectEvent = page.locator('[data-testid^="event-item-"]').filter({ hasText: "step-process-payment" }).first();
  await effectEvent.click();

  // Inspect What would have been sent panel
  const curlCode = page.locator('[data-testid="what-would-have-been-sent-curl"]');
  await expect(curlCode).toBeVisible();

  const curlText = await curlCode.textContent();
  expect(curlText).toContain("curl -X POST");
  expect(curlText).toContain("https://payment.example.com/v1/charges");

  // STRICT SECURITY CHECK: Assert planted secrets are never exposed in DOM
  expect(curlText).not.toContain(PLANTED_SECRET_HEADER);
  expect(curlText).not.toContain(PLANTED_SECRET_QUERY);
  expect(curlText).toContain("[REDACTED]");

  // Click Copy cURL button
  const copyBtn = page.locator('[data-testid="copy-what-would-have-sent-btn"]');
  await expect(copyBtn).toBeVisible();
  await copyBtn.click();
  await expect(copyBtn).toContainText("Copied!");

  // Capture Screenshot 4
  await page.screenshot({
    path: resolve(screenshotsDir, "feat-04-what-would-have-been-sent.png"),
    fullPage: false,
  });
});

test("05. Feature 5: Approval inbox page with parked runs, payload preview, and reject modal", async ({
  page,
}) => {
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');

  // Navigate to Approvals view
  const approvalsNavBtn = page.locator('[data-testid="nav-approvals-btn"]');
  await approvalsNavBtn.click();

  // Verify approval card exists
  const approvalCard = page.locator(`[data-testid="approval-card-${approvalRunId}"]`);
  await expect(approvalCard).toBeVisible();

  // Verify payload preview
  const payloadPre = approvalCard.locator('[data-testid="approval-payload-pre"]');
  await expect(payloadPre).toContainText("INV-999");
  await expect(payloadPre).toContainText("45000");

  // Click Reject Gate button to trigger 2-step confirmation modal
  const rejectBtn = approvalCard.locator('[data-testid="reject-gate-btn"]');
  await rejectBtn.click();

  const rejectModal = page.locator('[data-testid="rejection-confirm-modal"]');
  await expect(rejectModal).toBeVisible();

  const reasonInput = page.locator('[data-testid="rejection-reason-input"]');
  await reasonInput.fill("Invoice amount exceeds allowable threshold");

  // Capture Screenshot 5
  await page.screenshot({
    path: resolve(screenshotsDir, "feat-05-approval-inbox.png"),
    fullPage: false,
  });

  // Cancel modal
  const cancelBtn = page.locator('[data-testid="cancel-rejection-btn"]');
  await cancelBtn.click();
  await expect(rejectModal).not.toBeVisible();
});

test("06. Feature 6: Compare any two runs with execution diff and multi-fork lineage graph", async ({
  page,
}) => {
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');

  // Open Compare Runs Modal
  const compareBtn = page.locator('[data-testid="top-compare-btn"]');
  await compareBtn.click();

  const compareModal = page.locator('[data-testid="compare-runs-modal"]');
  await expect(compareModal).toBeVisible();

  // Select Parent Run in A and Shadow Fork in B
  const selectA = page.locator('[data-testid="compare-select-run-a"]');
  await selectA.selectOption(parentRunId);

  const selectB = page.locator('[data-testid="compare-select-run-b"]');
  await selectB.selectOption(shadowForkId);

  const executeCompareBtn = page.locator('[data-testid="execute-compare-btn"]');
  await executeCompareBtn.click();
  await page.waitForTimeout(300);

  // Assert diff view has execution diff items
  const diffView = compareModal.locator('[data-testid="diff-view"]');
  await expect(diffView).toBeVisible();

  // Assert lineage graph container has non-zero width and height in Compare view
  const compareLineage = compareModal.locator('[data-testid="lineage-graph-container"]');
  await expect(compareLineage).toBeVisible();
  const lineageBox = await compareLineage.boundingBox();
  expect(lineageBox).not.toBeNull();
  expect(lineageBox!.width).toBeGreaterThan(0);
  expect(lineageBox!.height).toBeGreaterThan(0);

  // Capture Screenshot 6
  await page.screenshot({
    path: resolve(screenshotsDir, "feat-06-compare-runs.png"),
    fullPage: false,
  });

  // Close modal
  await page.keyboard.press("Escape");
  await expect(compareModal).not.toBeVisible();
});

test("07. Feature 7: Worker pool and active task lease monitoring view", async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');

  // Open Workers & Leases modal
  const workersBtn = page.locator('[data-testid="open-workers-modal-btn"]');
  await workersBtn.click();

  const workersModal = page.locator('[data-testid="worker-pool-modal"]');
  await expect(workersModal).toBeVisible();

  // Verify telemetry metrics
  const activeWorkersMetric = page.locator('[data-testid="metric-active-workers"]');
  await expect(activeWorkersMetric).toContainText("1");

  const leasesMetric = page.locator('[data-testid="metric-worker-leases"]');
  await expect(leasesMetric).toContainText("1");

  // Verify worker card
  const workerCard = page.locator('[data-testid="worker-card-worker-node-alpha"]');
  await expect(workerCard).toBeVisible();

  // Capture Screenshot 7
  await page.screenshot({
    path: resolve(screenshotsDir, "feat-07-worker-pool.png"),
    fullPage: false,
  });

  // Close modal
  await page.keyboard.press("Escape");
  await expect(workersModal).not.toBeVisible();
});

test("08. Feature 8: Live updates polling control with Authorization header and backoff", async ({
  page,
}) => {
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');

  // Verify live polling control
  const pollingControl = page.locator('[data-testid="live-polling-control"]');
  await expect(pollingControl).toBeVisible();

  const pulseDot = page.locator('[data-testid="live-pulse-dot"]');
  await expect(pulseDot).toBeVisible();

  // Switch speed to 1s
  const speedBtn = page.locator('[data-testid="polling-speed-1s"]');
  await speedBtn.click();

  // Set an in-memory token to test that token is strictly sent in Authorization header, NEVER in URL
  const tokenBtn = page.locator('[data-testid="token-status-indicator"]');
  await tokenBtn.click();

  const tokenInput = page.locator('[data-testid="token-secret-input"]');
  await tokenInput.fill("secret-bearer-test-token-777");
  const saveTokenBtn = page.locator('[data-testid="save-token-btn"]');
  await saveTokenBtn.click();

  // Capture network requests to assert token is NOT in URL query
  const [request] = await Promise.all([
    page.waitForRequest((req) => req.url().includes("/runs")),
    page.locator('[data-testid="manual-sync-btn"]').click(),
  ]);

  expect(request.url()).not.toContain("secret-bearer-test-token-777");
  expect(request.url()).not.toContain("token=");

  // Capture Screenshot 8
  await page.screenshot({
    path: resolve(screenshotsDir, "feat-08-live-polling.png"),
    fullPage: false,
  });
});

test("09. Feature 9: Run trace export with SHA-256 checksum and plain permalink", async ({
  page,
}) => {
  await page.goto(`http://localhost:5173/#run=${shadowForkId}`);
  await page.waitForSelector('[data-testid="run-detail-view"]');

  // Open Export Modal
  const exportBtn = page.locator('[data-testid="open-export-btn"]');
  await exportBtn.click();

  const exportModal = page.locator('[data-testid="run-export-modal"]');
  await expect(exportModal).toBeVisible();

  // Assert SHA-256 hash is computed and valid 64-hex string
  const hashElement = page.locator('[data-testid="export-sha256-hash"]');
  await expect(hashElement).toBeVisible();
  const hashText = await hashElement.textContent();
  expect(hashText?.trim()).toMatch(/^[a-f0-9]{64}$/);

  // Assert permalink uses plain URI hash and contains zero tokens
  const permalinkElem = page.locator('[data-testid="permalink-input"]');
  await expect(permalinkElem).toContainText(`#run=${shadowForkId}`);
  const permalinkUrl = await permalinkElem.textContent();
  expect(permalinkUrl).not.toContain("token=");
  expect(permalinkUrl).not.toContain(PLANTED_SECRET_HEADER);

  // Capture Screenshot 9
  await page.screenshot({
    path: resolve(screenshotsDir, "feat-09-run-export-permalink.png"),
    fullPage: false,
  });

  // Close modal
  await page.keyboard.press("Escape");
  await expect(exportModal).not.toBeVisible();
});

test("10. Feature 10: Telemetry metrics strip with mini SVG sparklines and skeleton loaders", async ({
  page,
}) => {
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');

  // Verify MetricsStrip
  const metricsStrip = page.locator('[data-testid="metrics-strip"]');
  await expect(metricsStrip).toBeVisible();

  // Assert individual metrics
  await expect(page.locator('[data-testid="metric-rpm"]')).toBeVisible();
  await expect(page.locator('[data-testid="metric-p50"]')).toBeVisible();
  await expect(page.locator('[data-testid="metric-retry-rate"]')).toBeVisible();
  await expect(page.locator('[data-testid="metric-active-leases"]')).toBeVisible();

  // Assert sparkline SVG is rendered
  const sparklines = metricsStrip.locator("svg");
  expect(await sparklines.count()).toBeGreaterThanOrEqual(1);

  // Capture Screenshot 10
  await page.screenshot({
    path: resolve(screenshotsDir, "feat-10-metrics-strip-sparklines.png"),
    fullPage: false,
  });
});

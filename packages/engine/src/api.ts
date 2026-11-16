import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Pool } from "pg";
import type { Engine, ForkEdit, ForkMocksOption } from "./engine.js";
import { loadEvents, type StoredEvent } from "./events.js";
import { redactApiOutput } from "./redact.js";

export interface CreateApiOptions {
  engine: Engine;
  pool: Pool;
}

export interface EffectDiffItem {
  stepName: string;
  occurrence: number;
  reusedFromParent: boolean;
  inputChangedFromParent: boolean;
  status: "reused" | "modified" | "added" | "live";
  parent: {
    seq?: number;
    input?: unknown;
    result?: unknown;
    effects: Array<{
      kind: string;
      request: unknown;
      wouldHaveResult?: unknown;
      resultSource?: string;
    }>;
  } | null;
  shadow: {
    seq?: number;
    input?: unknown;
    result?: unknown;
    effects: Array<{
      kind: string;
      request: unknown;
      wouldHaveResult?: unknown;
      resultSource?: string;
      reusedFromParent?: boolean;
      inputChangedFromParent?: boolean;
    }>;
  } | null;
}

/**
 * Builds the side-by-side effect diff between a shadow fork and its parent run.
 */
export function buildEffectDiff(
  run: { id: string; parent_run_id: string | null; forked_from_seq: number | null },
  shadowEvents: StoredEvent[],
  parentEvents: StoredEvent[],
): EffectDiffItem[] {
  // If not a fork, list steps from the current run
  if (!run.parent_run_id) {
    const items: EffectDiffItem[] = [];
    const occurrences: Record<string, number> = {};

    let currentStep: {
      name: string;
      occurrence: number;
      input: unknown;
      result?: unknown;
      effects: Array<{
        kind: string;
        request: unknown;
        wouldHaveResult?: unknown;
        resultSource?: string;
      }>;
    } | null = null;

    for (const ev of shadowEvents) {
      if (ev.type === "StepCompleted") {
        const payload = ev.payload as { name: string; input: unknown; result: unknown };
        const occ = occurrences[payload.name] ?? 0;
        occurrences[payload.name] = occ + 1;
        items.push({
          stepName: payload.name,
          occurrence: occ,
          reusedFromParent: false,
          inputChangedFromParent: false,
          status: "live",
          parent: null,
          shadow: {
            seq: ev.seq,
            input: payload.input,
            result: payload.result,
            effects: currentStep?.name === payload.name ? currentStep.effects : [],
          },
        });
        currentStep = null;
      } else if (ev.type === "EffectCaptured") {
        const p = ev.payload as {
          stepName: string;
          kind: string;
          request: unknown;
          wouldHaveResult?: unknown;
          resultSource?: string;
        };
        if (!currentStep || currentStep.name !== p.stepName) {
          const occ = occurrences[p.stepName] ?? 0;
          currentStep = { name: p.stepName, occurrence: occ, input: undefined, effects: [] };
        }
        currentStep.effects.push({
          kind: p.kind,
          request: p.request,
          wouldHaveResult: p.wouldHaveResult,
          resultSource: p.resultSource,
        });
      }
    }
    return items;
  }

  // Extract parent steps and effects grouped by (stepName, occurrence)
  interface StepInfo {
    seq: number;
    name: string;
    occurrence: number;
    input: unknown;
    result: unknown;
    effects: Array<{
      kind: string;
      request: unknown;
      wouldHaveResult?: unknown;
      resultSource?: string;
      reusedFromParent?: boolean;
      inputChangedFromParent?: boolean;
    }>;
  }

  function extractSteps(events: StoredEvent[]): StepInfo[] {
    const list: StepInfo[] = [];
    const occMap: Record<string, number> = {};
    const pendingEffects: Record<string, StepInfo["effects"]> = {};

    for (const ev of events) {
      if (ev.type === "EffectCaptured") {
        const p = ev.payload as {
          stepName: string;
          kind: string;
          request: unknown;
          wouldHaveResult?: unknown;
          resultSource?: string;
          reusedFromParent?: boolean;
          inputChangedFromParent?: boolean;
        };
        if (!pendingEffects[p.stepName]) {
          pendingEffects[p.stepName] = [];
        }
        pendingEffects[p.stepName]!.push({
          kind: p.kind,
          request: p.request,
          wouldHaveResult: p.wouldHaveResult,
          resultSource: p.resultSource,
          reusedFromParent: p.reusedFromParent,
          inputChangedFromParent: p.inputChangedFromParent,
        });
      } else if (ev.type === "StepCompleted") {
        const p = ev.payload as { name: string; input: unknown; result: unknown };
        const occ = occMap[p.name] ?? 0;
        occMap[p.name] = occ + 1;
        list.push({
          seq: ev.seq,
          name: p.name,
          occurrence: occ,
          input: p.input,
          result: p.result,
          effects: pendingEffects[p.name] ?? [],
        });
        delete pendingEffects[p.name];
      }
    }
    return list;
  }

  const parentSteps = extractSteps(parentEvents);
  const shadowSteps = extractSteps(shadowEvents);

  const diffItems: EffectDiffItem[] = [];

  for (const shadowStep of shadowSteps) {
    const parentMatch = parentSteps.find(
      (p) => p.name === shadowStep.name && p.occurrence === shadowStep.occurrence,
    );

    const forkedSeq = run.forked_from_seq ?? 0;
    const isReused = shadowStep.seq < forkedSeq;

    let inputChanged = false;
    if (parentMatch) {
      inputChanged = JSON.stringify(parentMatch.input) !== JSON.stringify(shadowStep.input);
    } else {
      inputChanged = true;
    }

    let status: EffectDiffItem["status"] = "live";
    if (isReused) {
      status = "reused";
    } else if (!parentMatch) {
      status = "added";
    } else if (inputChanged) {
      status = "modified";
    }

    diffItems.push({
      stepName: shadowStep.name,
      occurrence: shadowStep.occurrence,
      reusedFromParent: isReused,
      inputChangedFromParent: inputChanged,
      status,
      parent: parentMatch
        ? {
            seq: parentMatch.seq,
            input: parentMatch.input,
            result: parentMatch.result,
            effects: parentMatch.effects,
          }
        : null,
      shadow: {
        seq: shadowStep.seq,
        input: shadowStep.input,
        result: shadowStep.result,
        effects: shadowStep.effects,
      },
    });
  }

  return diffItems;
}

/**
 * Creates the Hono HTTP API application for the Durable engine.
 *
 * Framework Choice: Hono
 * Justification:
 * 1. Web Standards Native: Uses Request and Response objects native to Node 24+, standard fetch API.
 * 2. Zero External Dependencies: Core hono routing has 0 sub-dependencies, ensuring fast cold-start and lean footprint.
 * 3. Fast Zero-Port In-Memory Testing: app.request() executes directly in Vitest without listening on TCP sockets or port collisions.
 * 4. TypeScript-First Inference: Clean typed params, query, and JSON payloads.
 * 5. Node.js Production Serving: Seamlessly compatible with @hono/node-server when TCP listening is required.
 */
export function createApiApp(options: CreateApiOptions): Hono {
  const { engine, pool } = options;
  const app = new Hono();

  // Enable CORS for inspector dashboard
  app.use("*", cors());

  // Error handling middleware with fail-closed redaction
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      redactApiOutput({
        error: message,
      }),
      500,
    );
  });

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Helper endpoint to start a new run (useful for dashboard / tests)
  app.post("/runs", async (c) => {
    const body = await c.req.json<{ workflowType: string; input?: unknown }>();
    if (!body?.workflowType) {
      return c.json({ error: "Missing workflowType in request body" }, 400);
    }
    const runId = await engine.startRun(body.workflowType, body.input);
    return c.json(redactApiOutput({ runId }), 201);
  });

  /**
   * 1. GET /runs
   * List runs with status, timing, and mode.
   * Query params: status, mode, limit.
   */
  app.get("/runs", async (c) => {
    const statusFilter = c.req.query("status");
    const modeFilter = c.req.query("mode");
    const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (statusFilter) {
      params.push(statusFilter);
      conditions.push(`r.status = $${params.length}`);
    }
    if (modeFilter) {
      params.push(modeFilter);
      conditions.push(`r.mode = $${params.length}`);
    }

    params.push(Math.min(Math.max(limit, 1), 200));
    const limitPlaceholder = `$${params.length}`;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pool.query<{
      id: string;
      workflow_type: string;
      status: string;
      mode: string;
      input: unknown;
      parent_run_id: string | null;
      forked_from_seq: number | null;
      fork_edit: unknown;
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT 
         r.id,
         r.workflow_type,
         r.status,
         r.mode,
         r.input,
         r.parent_run_id,
         r.forked_from_seq,
         r.fork_edit,
         r.created_at,
         MIN(e.created_at) FILTER (WHERE e.type = 'RunStarted') as started_at,
         MAX(e.created_at) FILTER (WHERE e.type IN ('RunCompleted', 'RunFailed')) as completed_at
       FROM runs r
       LEFT JOIN events e ON r.id = e.run_id
       ${whereClause}
       GROUP BY r.id
       ORDER BY r.created_at DESC
       LIMIT ${limitPlaceholder}`,
      params,
    );

    const result = rows.map((row) => {
      const startedAt = row.started_at ?? row.created_at;
      const completedAt = row.completed_at;
      const durationMs = completedAt
        ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
        : null;

      return {
        id: row.id,
        workflowType: row.workflow_type,
        status: row.status,
        mode: row.mode,
        input: row.input,
        parentRunId: row.parent_run_id,
        forkedFromSeq: row.forked_from_seq,
        forkEdit: row.fork_edit,
        timing: {
          createdAt: row.created_at,
          startedAt,
          completedAt,
          durationMs,
        },
      };
    });

    // Read-time redaction applied across every run row and nested fields
    return c.json(redactApiOutput(result));
  });

  /**
   * 2. GET /runs/:id
   * Full event log, current status, timing, and task state.
   */
  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");

    const { rows: runRows } = await pool.query<{
      id: string;
      workflow_type: string;
      status: string;
      mode: string;
      input: unknown;
      parent_run_id: string | null;
      forked_from_seq: number | null;
      fork_edit: unknown;
      created_at: Date;
    }>(
      `SELECT id, workflow_type, status, mode, input, parent_run_id, forked_from_seq, fork_edit, created_at 
       FROM runs WHERE id = $1`,
      [id],
    );

    const run = runRows[0];
    if (!run) {
      return c.json({ error: `Run not found: ${id}` }, 404);
    }

    const events = await loadEvents(pool, id);

    const { rows: taskRows } = await pool.query<{
      id: string;
      run_id: string;
      step_key: string;
      attempt: number;
      status: string;
      run_at: Date;
      lease_owner: string | null;
      lease_expires_at: Date | null;
      last_heartbeat_at: Date | null;
    }>(
      `SELECT id, run_id, step_key, attempt, status, run_at, lease_owner, lease_expires_at, last_heartbeat_at
       FROM tasks WHERE run_id = $1 ORDER BY run_at ASC, id ASC`,
      [id],
    );

    const startedEvent = events.find((e) => e.type === "RunStarted");
    const completedEvent = events.find((e) => e.type === "RunCompleted" || e.type === "RunFailed");

    const startedAt = startedEvent?.createdAt ?? run.created_at;
    const completedAt = completedEvent?.createdAt ?? null;
    const durationMs = completedAt
      ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
      : null;

    const responseData = {
      id: run.id,
      workflowType: run.workflow_type,
      status: run.status,
      mode: run.mode,
      input: run.input,
      parentRunId: run.parent_run_id,
      forkedFromSeq: run.forked_from_seq,
      forkEdit: run.fork_edit,
      timing: {
        createdAt: run.created_at,
        startedAt,
        completedAt,
        durationMs,
      },
      events: events.map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
      tasks: taskRows.map((t) => ({
        id: t.id,
        runId: t.run_id,
        stepKey: t.step_key,
        attempt: t.attempt,
        status: t.status,
        runAt: t.run_at,
        leaseOwner: t.lease_owner,
        leaseExpiresAt: t.lease_expires_at,
        lastHeartbeatAt: t.last_heartbeat_at,
      })),
    };

    // Read-time redaction applied to event payloads, step inputs, results, errors, tasks, and run inputs
    return c.json(redactApiOutput(responseData));
  });

  /**
   * 3. GET /runs/:id/effects
   * Diff view: original vs shadow effects, side-by-side with reusedFromParent and inputChangedFromParent.
   */
  app.get("/runs/:id/effects", async (c) => {
    const id = c.req.param("id");

    const { rows: runRows } = await pool.query<{
      id: string;
      workflow_type: string;
      status: string;
      mode: string;
      parent_run_id: string | null;
      forked_from_seq: number | null;
    }>(
      `SELECT id, workflow_type, status, mode, parent_run_id, forked_from_seq FROM runs WHERE id = $1`,
      [id],
    );

    const run = runRows[0];
    if (!run) {
      return c.json({ error: `Run not found: ${id}` }, 404);
    }

    const shadowEvents = await loadEvents(pool, id);
    let parentEvents: StoredEvent[] = [];
    if (run.parent_run_id) {
      parentEvents = await loadEvents(pool, run.parent_run_id);
    }

    const diffItems = buildEffectDiff(run, shadowEvents, parentEvents);

    const responseData = {
      runId: id,
      isFork: !!run.parent_run_id,
      parentRunId: run.parent_run_id,
      forkedFromSeq: run.forked_from_seq,
      mode: run.mode,
      steps: diffItems,
    };

    // Read-time redaction applied to effects diff
    return c.json(redactApiOutput(responseData));
  });

  /**
   * 4. POST /runs/:id/fork
   * Fork at atSeq with edit and mocks. Returns { runId, warnings }.
   */
  app.post("/runs/:id/fork", async (c) => {
    const id = c.req.param("id");

    const { rows: runRows } = await pool.query<{
      id: string;
      workflow_type: string;
      status: string;
      mode: string;
    }>(`SELECT id, workflow_type, status, mode FROM runs WHERE id = $1`, [id]);

    const run = runRows[0];
    if (!run) {
      return c.json({ error: `Run not found: ${id}` }, 404);
    }

    const body = await c.req.json<{
      atSeq: number;
      edit?: ForkEdit;
      mocks?: ForkMocksOption;
    }>();

    if (!body || typeof body.atSeq !== "number" || body.atSeq < 1) {
      return c.json({ error: "Missing or invalid 'atSeq' in request body" }, 400);
    }

    const warnings: string[] = [];
    if (run.mode === "shadow") {
      warnings.push("Parent run was already in shadow mode; created nested shadow fork.");
    }

    // Determine edit and mocks
    let editToPass: ForkEdit;
    if (body.edit && typeof body.edit === "object") {
      editToPass = { ...body.edit };
      if (body.mocks && !("mocks" in editToPass)) {
        editToPass.mocks = body.mocks;
      }
    } else if (body.mocks) {
      editToPass = { mocks: body.mocks };
    } else {
      return c.json(
        { error: "Must provide either 'edit' or 'mocks' in request body to fork" },
        400,
      );
    }

    if ("mocks" in editToPass && editToPass.mocks) {
      warnings.push("Mocks configured for shadow execution.");
    }
    if ("input" in editToPass) {
      warnings.push("Step input modified from parent run.");
    }
    if ("result" in editToPass) {
      warnings.push("Step result overridden from parent run.");
    }

    try {
      const forkedRunId = await engine.fork(id, body.atSeq, editToPass, { mocks: body.mocks });
      return c.json(
        redactApiOutput({
          runId: forkedRunId,
          warnings,
        }),
        201,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(redactApiOutput({ error: message }), 400);
    }
  });

  /**
   * 5. POST /runs/:id/resume
   * Resumes failed or stalled run.
   */
  app.post("/runs/:id/resume", async (c) => {
    const id = c.req.param("id");

    const { rows: runRows } = await pool.query<{
      id: string;
      workflow_type: string;
      status: string;
      mode: string;
    }>(`SELECT id, workflow_type, status, mode FROM runs WHERE id = $1`, [id]);

    const run = runRows[0];
    if (!run) {
      return c.json({ error: `Run not found: ${id}` }, 404);
    }

    if (run.status === "completed") {
      return c.json(
        redactApiOutput({
          success: true,
          runId: id,
          status: "completed",
          message: "Run is already completed",
        }),
      );
    }

    try {
      // 1. Reap any expired task leases first
      await engine.reap();

      // 2. If run is running and has a pending task delayed in the future, fast-forward run_at
      await pool.query(
        `UPDATE tasks SET run_at = now() WHERE run_id = $1 AND status = 'pending' AND run_at > now()`,
        [id],
      );

      // 3. Execute with resumeFailed enabled so failed runs can be retried/resumed
      const outcome = await engine.execute(id, { resumeFailed: true });

      return c.json(
        redactApiOutput({
          success: outcome.status === "completed",
          runId: id,
          status: outcome.status,
          outcome,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(redactApiOutput({ error: message }), 500);
    }
  });

  return app;
}

import type { Pool, PoolClient } from "pg";
import { FencingError } from "./errors.js";

export interface TaskRow {
  id: string;
  run_id: string;
  step_key: string;
  attempt: number;
  status: "pending" | "running" | "completed" | "failed";
  run_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_heartbeat_at: Date | null;
}

export type Db = Pool | PoolClient;

/**
 * Claims the next available pending task using SKIP LOCKED.
 * Atomic: locks and claims exactly one pending task whose run_at <= now().
 * Optionally filters by registered workflow types and supports injectable clock.
 */
export async function claimTask(
  db: Db,
  workerId: string,
  leaseDurationMs: number,
  workflowTypes?: string[],
  now?: Date,
): Promise<TaskRow | null> {
  const { rows } = await db.query<TaskRow>(
    `UPDATE tasks
     SET status = 'running',
         lease_owner = $1,
         lease_expires_at = COALESCE($4::timestamptz, now()) + ($2 || ' milliseconds')::interval,
         last_heartbeat_at = COALESCE($4::timestamptz, now()),
         attempt = attempt + 1
     WHERE id = (
       SELECT t.id
       FROM tasks t
       JOIN runs r ON t.run_id = r.id
       WHERE t.status = 'pending' AND t.run_at <= COALESCE($4::timestamptz, now())
         AND ($3::text[] IS NULL OR r.workflow_type = ANY($3::text[]))
       ORDER BY t.run_at ASC
       FOR UPDATE OF t SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, run_id, step_key, attempt, status, run_at, lease_owner, lease_expires_at, last_heartbeat_at`,
    [workerId, leaseDurationMs, workflowTypes ?? null, now ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Extends lease_expires_at for a running task owned by workerId.
 * Returns true if the lease was extended, false if the lease was lost.
 */
export async function heartbeatTask(
  db: Db,
  taskId: string,
  workerId: string,
  leaseDurationMs: number,
  now?: Date,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE tasks
     SET lease_expires_at = COALESCE($4::timestamptz, now()) + ($1 || ' milliseconds')::interval,
         last_heartbeat_at = COALESCE($4::timestamptz, now())
     WHERE id = $2 AND lease_owner = $3 AND status = 'running'`,
    [leaseDurationMs, taskId, workerId, now ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Returns expired running tasks to pending status so another worker can claim them.
 * Optionally filters by registered workflow types and supports injectable clock.
 */
export async function reapTasks(db: Db, now?: Date, workflowTypes?: string[]): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE tasks
     SET status = 'pending',
         lease_owner = NULL,
         lease_expires_at = NULL
     WHERE status = 'running'
       AND lease_expires_at < COALESCE($1::timestamptz, now())
       AND ($2::text[] IS NULL OR run_id IN (SELECT id FROM runs WHERE workflow_type = ANY($2::text[])))
     RETURNING id`,
    [now ?? null, workflowTypes ?? null],
  );
  return rows.map((r) => r.id);
}

/**
 * Schedules a retry for a running task owned by workerId.
 * Sets status to 'pending', clears lease ownership, and sets run_at to runAt.
 * Throws FencingError if workerId is not the current lease owner.
 */
export async function scheduleRetry(
  db: Db,
  taskId: string,
  workerId: string,
  runAt: Date,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE tasks
     SET status = 'pending',
         lease_owner = NULL,
         lease_expires_at = NULL,
         run_at = $1
     WHERE id = $2 AND lease_owner = $3 AND status = 'running'`,
    [runAt, taskId, workerId],
  );
  if ((rowCount ?? 0) === 0) {
    throw new FencingError(taskId, workerId);
  }
}

/**
 * Marks a task completed, checking lease_owner (fencing).
 * Throws FencingError if workerId no longer holds the lease.
 */
export async function completeTask(db: Db, taskId: string, workerId: string): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE tasks
     SET status = 'completed',
         lease_expires_at = NULL
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [taskId, workerId],
  );
  if ((rowCount ?? 0) === 0) {
    throw new FencingError(taskId, workerId);
  }
}

/**
 * Marks a task failed, checking lease_owner (fencing).
 * Throws FencingError if workerId no longer holds the lease.
 */
export async function failTask(db: Db, taskId: string, workerId: string): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE tasks
     SET status = 'failed',
         lease_expires_at = NULL
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [taskId, workerId],
  );
  if ((rowCount ?? 0) === 0) {
    throw new FencingError(taskId, workerId);
  }
}

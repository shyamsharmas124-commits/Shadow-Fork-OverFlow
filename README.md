# durable

A durable workflow engine with Postgres-backed event sourcing, leasing, replay, and (planned)
**shadow forking**: edit the input at event N, re-run forward with side effects captured instead
of executed, then diff against the original.

## Status
- [x] Milestone 1: schema, append-only event log, `ctx.step`/`now`/`random`, replay,
      `NonDeterminismError`, crash-and-resume tests, fast-check property test
- [x] Milestone 2: leasing (claim, heartbeat, reaper, fencing)
- [x] Milestone 3: retries, timeouts, idempotency keys
- [x] Milestone 4: fork API, connectors with live/shadow modes, AST-based SQL parser, egress guards
- [x] Milestone 5a: HTTP API (Hono) with read-time redaction, side-by-side effect diffing, and run resumption
- [ ] Milestone 5b: inspector UI dashboard
- [ ] Milestone 6: demo workflow, chaos script, README diagrams

## Run
```bash
pnpm install
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/durable
pnpm --filter @durable/engine migrate
pnpm test
```

Tests use `DATABASE_URL`. To use Testcontainers instead, replace `makePool()` in
`packages/engine/test/helpers.ts`; the engine only needs a connection string.

## Design notes
- `events` is append-only, enforced by a trigger, with PK `(run_id, seq)` so concurrent writers
  collide instead of corrupting history.
- Replay checks step name **and** input hash against history; any mismatch raises
  `NonDeterminismError` with the event position.
- `CrashSignal` stands in for a process kill in tests: nothing is recorded, the run stays resumable.

### Shadow Execution & Safety Notes
- **Threat Model**: Shadow guards protect against bugs and accidents in the developer's own workflow code, not against deliberately malicious step code, and shadow SQL is a best-effort guard, not a sandbox. For defense-in-depth, we recommend running shadow transactions under a restricted database role with minimal privileges.
- **Shadow SQL Transactions & Sequences**: Reversible SQL steps in shadow mode execute inside dedicated transactions that are guaranteed to `ROLLBACK` in a `finally` block on completion, error, timeout, or abort. Note that Postgres sequence generators (such as `SERIAL`, `BIGSERIAL`, or `nextval(...)`) are inherently non-transactional by Postgres engine design: sequence values consumed during a shadow step are **not** rolled back when the transaction aborts.
- **Egress Guard Boundaries & AsyncLocalStorage Propagation**: Shadow mode step execution activates an `AsyncLocalStorage`-backed egress guard that intercepts `globalThis.fetch`, `node:http.request`, `node:http.get`, `node:https.request`, and `node:https.get` (including named ESM imports synchronized via `node:module`'s `syncBuiltinESMExports()`), throwing `ShadowEgressError` on any unauthorized outbound network request.
  - **Context Propagation**: The shadow ALS context cleanly survives across Promise chains (`.then()`, `await`), timers (`setTimeout`, `setInterval`), `EventEmitter` listeners invoked synchronously within the step, and callbacks called synchronously within the step.
  - **Where it breaks**: If an external background task or long-lived server registered an event emitter or callback *outside* the shadow step and triggers it asynchronously from an external event source (such as an external socket connection or external queue processing loop outside the workflow engine), that asynchronous handler runs in the background task's own context, not the step's shadow context.
  - Plainly, this guard also does **NOT** cover:
    1. Direct socket connections via raw `node:net` or `node:dgram` sockets.
    2. Out-of-band third-party database clients or connection pools initialized outside the workflow engine context.
    3. Native compiled C/C++ addons or child processes spawned via `node:child_process` that perform independent networking.

### Where Secrets Can Live & Redaction Timing

All external effect requests captured by shadow connectors are redacted at **write-time** before persistence to the append-only `events` table. However, replay inputs and results cannot be redacted at write-time without mutating input hashes and breaking deterministic replay guarantees; therefore, workflow inputs, step results, and error logs are redacted at **read-time** in the API layer before presentation.

| Location | Example Pattern | Redaction Strategy | Timing |
|---|---|---|---|
| **Effect Headers** | `Authorization: Bearer ...`, `Cookie: ...` | Sensitive key match (`[REDACTED]`) + value-shape scan for JWT, Bearer, API keys | **Write-time** (connector -> `EffectCaptured`) |
| **Effect URL Query** | `?token=xyz`, `?data=%E0%A4%A` | Sensitive param names -> `[REDACTED]`; malformed query strings fail closed (`?[REDACTED]`); value patterns redacted | **Write-time** (connector -> `EffectCaptured`) |
| **Effect Request Body** | `{"password": "secret", "note": "sk-..."}` | Sensitive keys -> `[REDACTED]`; string values scanned for Bearer, JWT, `sk-`, `ghp_`, `AKIA` | **Write-time** (connector -> `EffectCaptured`) |
| **Effect URL Userinfo** | `https://admin:secret@api.com` | Userinfo extracted and replaced with `https://[REDACTED]:[REDACTED]@api.com` | **Write-time** (connector -> `EffectCaptured`) |
| **Effect URL Path** | `https://api.com/keys/sk-...` | Value patterns (`sk-`, `ghp_`, `AKIA`, JWT) stripped from path strings via `redactStringValue` | **Write-time** (connector -> `EffectCaptured`) |
| **`StepCompleted.input`** | `{ "apiKey": "sk-..." }` | Cannot redact at write-time (would invalidate `inputHash` and break replay). Redacted recursively in API inspector serializer. | **Read-time** (API layer) |
| **`StepCompleted.result`** | `{ "token": "ey..." }` | Cannot redact at write-time (downstream steps receive this result on replay). Redacted recursively in API inspector serializer. | **Read-time** (API layer) |
| **`StepFailed.error`** | `Failed: secret key sk-... rejected` | Exception string containing sensitive values. Redacted in API inspector serializer. | **Read-time** (API layer) |
| **`EffectCaptured.wouldHaveResult`** | `{ "apiKey": "sk-..." }` | Reused or mocked return payload for the effect. Redacted in API inspector serializer. | **Read-time** (API layer) |
| **`runs.input`** | `{ "webhookSecret": "..." }` | Workflow initial payload stored in `runs` row. Redacted in API inspector serializer. | **Read-time** (API layer) |
| **`runs.fork_edit`** | `{ input: { "token": "..." }, mocks: [...] }` | Fork input override and mocks stored in `runs` row. Redacted in API inspector serializer. | **Read-time** (API layer) |

> [!WARNING]
> Read-time redaction is best effort (field names and value patterns); a secret stored under an ordinary field name can still reach API clients, so the API must be treated as exposing whatever workflows store.

### Milestone 5a HTTP API, Access Control & Run Resumption

Built on **Hono**:
- **Web Standards Native**: Built on standard `Request` and `Response` objects supported natively by Node.js 24 (`globalThis.Request`, `globalThis.Response`).
- **Zero External Dependencies**: Core routing engine has 0 sub-dependencies, ensuring sub-millisecond route dispatch and a lean package footprint.
- **Flawless In-Memory Testing**: `app.request(path, options)` enables complete unit and integration testing without opening TCP sockets or managing port collisions in Vitest.
- **Node.js HTTP Server Compatibility**: `@hono/node-server` provides a lightweight bridge to Node's `http` module for standalone server execution.

#### Security, Host Binding & Access Control
- **CORS is NOT Authentication**: CORS headers only govern browser cross-origin requests and do not protect the API from non-browser clients, script access, or local loopback inspection.
- **Loopback Default Binding**: The API server binds strictly to `127.0.0.1` by default. Binding to an external or non-loopback host (e.g. `0.0.0.0`) requires an explicit `HOST` configuration and logs a security warning.
- **Mandatory API_TOKEN on External Interfaces**: If `HOST` is configured to a non-loopback address and `API_TOKEN` is unset, the server **refuses to start** with an error.
- **Constant-Time Token Verification**: Mutating endpoints (`POST /runs`, `POST /runs/:id/fork`, `POST /runs/:id/resume`) require `Authorization: Bearer <API_TOKEN>`, compared in constant-time using `node:crypto.timingSafeEqual` to eliminate timing side channels. Missing or invalid tokens return 401 Unauthorized without triggering any database side effects.
- **Read-Only Loopback Access**: GET endpoints (`/runs`, `/runs/:id`, `/runs/:id/effects`, `/health`) remain accessible on loopback without a token for seamless local UI dashboard inspection.

#### Resume Endpoint Semantics & Append-Only Guarantees
The `POST /runs/:id/resume` endpoint allows safely resuming interrupted workflows:
1. **(i) Stalled Runs**: A run stalled due to a crashed worker or expired lease is revived. The engine reaps expired leases (`UPDATE tasks SET status = 'pending', lease_owner = NULL WHERE status = 'running' AND lease_expires_at < now()`) and resets future-scheduled pending tasks (`UPDATE tasks SET run_at = now() WHERE run_id = $1 AND status = 'pending' AND run_at > now()`). Execution resumes immediately.
2. **(ii) Failed Runs with `RunFailed`**: When a run failed due to a transient exception, its state can be resumed without violating the append-only audit trail:
   ```sql
   -- Simplified Resume SQL
   UPDATE runs SET status = 'running' WHERE id = $1;
   UPDATE tasks SET status = 'pending', run_at = now(), lease_owner = NULL, lease_expires_at = NULL 
   WHERE run_id = $1 AND status != 'completed';
   ```
   - **Append-Only Proof**: The `events` table is protected by a Postgres database trigger (`prevent_event_mutation`) that immediately raises an exception on any `UPDATE` or `DELETE`. The engine **never** edits or deletes existing events. The previous `RunFailed` event remains permanently preserved at its sequence number (`seq`). On replay, completed steps return their recorded results, the failed step retries live, and upon success a `RunCompleted` event is appended at the *next* sequence number (`seq + 1`).
   - **Concurrency Safety via Advisory Locks**: Resumption is serialized per `runId` using Postgres advisory locks (`SELECT pg_advisory_lock(hashtext($1))`). Simultaneous resume requests execute safely: exactly 1 worker claims and executes the task, while concurrent calls wait and return the completed status once finished.

#### Endpoints
1. `GET /runs`: Lists runs with status, timing (`createdAt`, `startedAt`, `completedAt`, `durationMs`), and mode (`live` vs `shadow`). Supports `status`, `mode`, and `limit` query filters.
2. `GET /runs/:id`: Returns run metadata, complete event log ordered by sequence number (`seq ASC`), timing, and active task state from the `tasks` table.
3. `GET /runs/:id/effects`: Side-by-side diff view of parent vs shadow effects, highlighting `reusedFromParent`, `inputChangedFromParent`, original results vs shadow `wouldHaveResult`, and connector effects.
4. `POST /runs/:id/fork`: Creates a shadow fork from run `:id` at sequence `atSeq` with optional input/result edit and mocks. Returns `{ runId, warnings }`.
5. `POST /runs/:id/resume`: Resumes stalled runs or failed runs safely and idempotently.

### Verified Environment & Supported Engines
- **Node.js**: `v24.14.1` (package `engines.node` set to `>=24.0.0`)
- **PostgreSQL**: `PostgreSQL 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 15.2.0-16ubuntu1) 15.2.0, 64-bit`



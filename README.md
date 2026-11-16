# durable

A durable workflow engine with Postgres-backed event sourcing, leasing, replay, and (planned)
**shadow forking**: edit the input at event N, re-run forward with side effects captured instead
of executed, then diff against the original.

## Status
- [x] Milestone 1: schema, append-only event log, `ctx.step`/`now`/`random`, replay,
      `NonDeterminismError`, crash-and-resume tests, fast-check property test
- [x] Milestone 2: leasing (claim, heartbeat, reaper, fencing)
- [x] Milestone 3: retries, timeouts, idempotency keys
- [ ] Milestone 4: fork API, connectors with live/shadow modes
- [ ] Milestone 5: inspector UI
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
- **Shadow SQL Transactions & Sequences**: Reversible SQL steps in shadow mode execute inside dedicated transactions that are guaranteed to `ROLLBACK` in a `finally` block on completion, error, timeout, or abort. Note that Postgres sequence generators (such as `SERIAL`, `BIGSERIAL`, or `nextval(...)`) are inherently non-transactional by Postgres engine design: sequence values consumed during a shadow step are **not** rolled back when the transaction aborts.
- **Egress Guard Boundaries & AsyncLocalStorage Propagation**: Shadow mode step execution activates an `AsyncLocalStorage`-backed egress guard that intercepts `globalThis.fetch`, `node:http.request`, `node:http.get`, `node:https.request`, and `node:https.get` (including named ESM imports synchronized via `node:module`'s `syncBuiltinESMExports()`), throwing `ShadowEgressError` on any unauthorized outbound network request.
  - **Context Propagation**: The shadow ALS context cleanly survives across Promise chains (`.then()`, `await`), timers (`setTimeout`, `setInterval`), `EventEmitter` listeners invoked synchronously within the step, and callbacks called synchronously within the step.
  - **Where it breaks**: If an external background task or long-lived server registered an event emitter or callback *outside* the shadow step and triggers it asynchronously from an external event source (such as an external socket connection or external queue processing loop outside the workflow engine), that asynchronous handler runs in the background task's own context, not the step's shadow context.
  - Plainly, this guard also does **NOT** cover:
    1. Direct socket connections via raw `node:net` or `node:dgram` sockets.
    2. Out-of-band third-party database clients or connection pools initialized outside the workflow engine context.
    3. Native compiled C/C++ addons or child processes spawned via `node:child_process` that perform independent networking.

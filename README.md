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

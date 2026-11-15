-- Core schema. `events` is append-only: never UPDATE or DELETE rows.
CREATE TABLE IF NOT EXISTS runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type    text        NOT NULL,
  status           text        NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','completed','failed')),
  input            jsonb       NOT NULL,
  parent_run_id    uuid        REFERENCES runs(id),
  forked_from_seq  integer,
  fork_edit        jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  run_id      uuid        NOT NULL REFERENCES runs(id),
  seq         integer     NOT NULL,
  type        text        NOT NULL,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

-- Used from Milestone 2 (leasing). Created now so the schema is stable.
CREATE TABLE IF NOT EXISTS tasks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid        NOT NULL REFERENCES runs(id),
  step_key           text        NOT NULL,
  attempt            integer     NOT NULL DEFAULT 0,
  status             text        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','running','completed','failed')),
  run_at             timestamptz NOT NULL DEFAULT now(),
  lease_owner        text,
  lease_expires_at   timestamptz,
  last_heartbeat_at  timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_claim_idx ON tasks (run_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS tasks_reap_idx  ON tasks (lease_expires_at) WHERE status = 'running';

-- Guard: events are append-only.
CREATE OR REPLACE FUNCTION events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_no_update ON events;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_immutable();

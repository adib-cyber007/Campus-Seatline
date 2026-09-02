BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'rider')),
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by_admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_by_admin_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));

CREATE TABLE IF NOT EXISTS stops (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by_admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE stops ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE stops ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE stops ADD COLUMN IF NOT EXISTS archived_by_admin_id uuid;

CREATE TABLE IF NOT EXISTS buses (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  capacity integer NOT NULL CHECK (capacity > 0),
  morning_start_time time NOT NULL DEFAULT '07:00',
  evening_start_time time NOT NULL DEFAULT '17:00',
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by_admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE buses ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE buses ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE buses ADD COLUMN IF NOT EXISTS archived_by_admin_id uuid;
ALTER TABLE buses ADD COLUMN IF NOT EXISTS morning_start_time time NOT NULL DEFAULT '07:00';
ALTER TABLE buses ADD COLUMN IF NOT EXISTS evening_start_time time NOT NULL DEFAULT '17:00';

CREATE TABLE IF NOT EXISTS bus_beacons (
  bus_id uuid PRIMARY KEY REFERENCES buses(id) ON DELETE CASCADE,
  service_uuid uuid NOT NULL UNIQUE,
  advertising_mode text NOT NULL DEFAULT 'legacy' CHECK (advertising_mode = 'legacy'),
  advertising_interval_ms integer NOT NULL DEFAULT 350
    CHECK (advertising_interval_ms BETWEEN 250 AND 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_stops (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stop_id uuid NOT NULL REFERENCES stops(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (user_id, stop_id),
  UNIQUE (user_id, position)
);

CREATE TABLE IF NOT EXISTS bus_stops (
  bus_id uuid NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
  stop_id uuid NOT NULL REFERENCES stops(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (bus_id, stop_id),
  UNIQUE (bus_id, position)
);

CREATE TABLE IF NOT EXISTS operating_calendar (
  id text PRIMARY KEY,
  service_weekdays jsonb NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_admin_id uuid REFERENCES users(id) ON DELETE RESTRICT
);
INSERT INTO operating_calendar (id, service_weekdays)
VALUES ('default', '[1,2,3,4,5]'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS operating_calendar_exceptions (
  service_date date PRIMARY KEY,
  service boolean NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_admin_id uuid REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS trips (
  id uuid PRIMARY KEY,
  bus_id uuid NOT NULL REFERENCES buses(id) ON DELETE RESTRICT,
  trip_date date NOT NULL,
  direction text NOT NULL CHECK (direction IN ('morning', 'evening')),
  stop_sequence jsonb NOT NULL,
  boarding_stop_set jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled', 'active', 'completed')),
  activated_at timestamptz,
  completed_at timestamptz,
  completion_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bus_id, trip_date, direction)
);
CREATE UNIQUE INDEX IF NOT EXISTS trips_one_active_per_bus
  ON trips (bus_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS trips_date_direction_idx
  ON trips (trip_date DESC, direction, bus_id);

CREATE TABLE IF NOT EXISTS incharge_assignments (
  id uuid PRIMARY KEY,
  rider_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope_type text NOT NULL CHECK (scope_type IN ('bus', 'stop')),
  bus_id uuid REFERENCES buses(id) ON DELETE RESTRICT,
  stop_id uuid REFERENCES stops(id) ON DELETE RESTRICT,
  granted_by_admin_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_admin_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (
    (scope_type = 'bus' AND bus_id IS NOT NULL AND stop_id IS NULL) OR
    (scope_type = 'stop' AND stop_id IS NOT NULL AND bus_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS incharge_active_bus_unique
  ON incharge_assignments (rider_id, bus_id)
  WHERE revoked_at IS NULL AND scope_type = 'bus';
CREATE UNIQUE INDEX IF NOT EXISTS incharge_active_stop_unique
  ON incharge_assignments (rider_id, stop_id)
  WHERE revoked_at IS NULL AND scope_type = 'stop';

CREATE TABLE IF NOT EXISTS boarding_reports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bus_id uuid NOT NULL REFERENCES buses(id) ON DELETE RESTRICT,
  stop_id uuid REFERENCES stops(id) ON DELETE RESTRICT,
  trip_date date NOT NULL,
  state text NOT NULL CHECK (state IN ('soft_hold', 'seats_occupied', 'released')),
  source text NOT NULL,
  release_reason text,
  released_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, bus_id, trip_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS boarding_reports_one_active_per_rider_trip
  ON boarding_reports (user_id, trip_date)
  WHERE state IN ('soft_hold', 'seats_occupied');
CREATE INDEX IF NOT EXISTS boarding_reports_bus_trip_idx
  ON boarding_reports (bus_id, trip_date);

CREATE TABLE IF NOT EXISTS occupancy_adjustments (
  bus_id uuid NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
  trip_date date NOT NULL,
  manual_adjustment integer NOT NULL DEFAULT 0,
  last_updated timestamptz NOT NULL,
  PRIMARY KEY (bus_id, trip_date)
);

CREATE TABLE IF NOT EXISTS ble_prompts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bus_id uuid NOT NULL REFERENCES buses(id) ON DELETE RESTRICT,
  stop_id uuid NOT NULL REFERENCES stops(id) ON DELETE RESTRICT,
  kind text NOT NULL DEFAULT 'ble_confirm',
  detection_source text NOT NULL,
  beacon jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'answered', 'expired', 'cancelled')),
  trip_date date NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  answered_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ble_prompts_one_pending_context
  ON ble_prompts (user_id, bus_id, stop_id, trip_date)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS arrival_events (
  id uuid PRIMARY KEY,
  bus_id uuid NOT NULL REFERENCES buses(id) ON DELETE RESTRICT,
  stop_id uuid NOT NULL REFERENCES stops(id) ON DELETE RESTRICT,
  trip_date date NOT NULL,
  timestamp timestamptz NOT NULL,
  inferred boolean NOT NULL DEFAULT false,
  inferred_from_stop_id uuid REFERENCES stops(id) ON DELETE RESTRICT,
  UNIQUE (bus_id, stop_id, trip_date)
);
ALTER TABLE arrival_events ADD COLUMN IF NOT EXISTS inferred boolean NOT NULL DEFAULT false;
ALTER TABLE arrival_events ADD COLUMN IF NOT EXISTS inferred_from_stop_id uuid REFERENCES stops(id) ON DELETE RESTRICT;
CREATE TABLE IF NOT EXISTS arrival_event_confirmations (
  arrival_event_id uuid NOT NULL REFERENCES arrival_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL,
  PRIMARY KEY (arrival_event_id, user_id)
);

CREATE TABLE IF NOT EXISTS report_attempts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bus_id uuid NOT NULL REFERENCES buses(id) ON DELETE RESTRICT,
  stop_id uuid REFERENCES stops(id) ON DELETE RESTRICT,
  trip_date date NOT NULL,
  channel text NOT NULL,
  requested text NOT NULL,
  outcome text NOT NULL,
  message text,
  timestamp timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS unmet_demand_events (
  id uuid PRIMARY KEY,
  rider_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stop_id uuid NOT NULL REFERENCES stops(id) ON DELETE RESTRICT,
  bus_id uuid NOT NULL REFERENCES buses(id) ON DELETE RESTRICT,
  channel text NOT NULL,
  trip_date date NOT NULL,
  had_alternate_bus boolean NOT NULL,
  alternate_bus_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  timestamp timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS unmet_demand_trip_stop_bus_idx
  ON unmet_demand_events (trip_date DESC, stop_id, bus_id);
CREATE INDEX IF NOT EXISTS unmet_demand_stranded_idx
  ON unmet_demand_events (trip_date DESC, had_alternate_bus);
CREATE TABLE IF NOT EXISTS incharge_overrides (
  id uuid PRIMARY KEY,
  incharge_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bus_id uuid NOT NULL REFERENCES buses(id) ON DELETE RESTRICT,
  trip_date date NOT NULL,
  previous_available integer NOT NULL,
  new_available integer NOT NULL,
  previous_occupied integer NOT NULL,
  new_occupied integer NOT NULL,
  timestamp timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_records (
  id text PRIMARY KEY,
  kind text NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  bus_id uuid REFERENCES buses(id) ON DELETE RESTRICT,
  stop_id uuid REFERENCES stops(id) ON DELETE RESTRICT,
  trip_date date,
  outcome text,
  detail text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  timestamp timestamptz NOT NULL
);
ALTER TABLE audit_records ALTER COLUMN id TYPE text USING id::text;
CREATE INDEX IF NOT EXISTS audit_records_timestamp_idx ON audit_records (timestamp DESC);

CREATE TABLE IF NOT EXISTS daily_stop_overrides (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stop_id uuid NOT NULL REFERENCES stops(id) ON DELETE RESTRICT,
  trip_date date NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, trip_date)
);

CREATE TABLE IF NOT EXISTS auto_hold_evaluations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_date date NOT NULL,
  context_key text NOT NULL,
  stop_ids jsonb NOT NULL,
  viable_bus_ids jsonb NOT NULL,
  outcome text NOT NULL,
  error text,
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, trip_date, context_key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message text NOT NULL,
  type text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fcm_device_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform = 'android'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  deactivated_at timestamptz,
  deactivation_reason text
);
CREATE INDEX IF NOT EXISTS fcm_device_tokens_active_user_idx
  ON fcm_device_tokens (user_id) WHERE active;

ALTER TABLE boarding_reports ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id) ON DELETE RESTRICT;
ALTER TABLE boarding_reports ADD COLUMN IF NOT EXISTS alight_stop_id uuid REFERENCES stops(id) ON DELETE RESTRICT;
ALTER TABLE boarding_reports ADD COLUMN IF NOT EXISTS trip_direction text NOT NULL DEFAULT 'morning';
ALTER TABLE boarding_reports DROP CONSTRAINT IF EXISTS boarding_reports_user_id_bus_id_trip_date_key;
DROP INDEX IF EXISTS boarding_reports_one_active_per_rider_trip;
UPDATE boarding_reports
SET state = 'released', release_reason = COALESCE(release_reason, 'legacy_day_closed'),
    released_at = COALESCE(released_at, now()), updated_at = now()
WHERE trip_date < current_date AND state IN ('soft_hold', 'seats_occupied');
CREATE UNIQUE INDEX IF NOT EXISTS boarding_reports_one_record_per_rider_bus_trip
  ON boarding_reports (user_id, trip_id) WHERE trip_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS boarding_reports_one_active_per_rider_service_trip
  ON boarding_reports (user_id, trip_date, trip_direction)
  WHERE state IN ('soft_hold', 'seats_occupied');
CREATE UNIQUE INDEX IF NOT EXISTS boarding_reports_one_soft_hold_globally
  ON boarding_reports (user_id) WHERE state = 'soft_hold';
CREATE INDEX IF NOT EXISTS boarding_reports_trip_idx ON boarding_reports (trip_id);

CREATE TABLE IF NOT EXISTS trip_occupancy_adjustments (
  trip_id uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  manual_adjustment integer NOT NULL DEFAULT 0,
  last_updated timestamptz NOT NULL
);

ALTER TABLE ble_prompts ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id) ON DELETE RESTRICT;
ALTER TABLE ble_prompts ADD COLUMN IF NOT EXISTS trip_direction text NOT NULL DEFAULT 'morning';
DROP INDEX IF EXISTS ble_prompts_one_pending_context;
CREATE UNIQUE INDEX IF NOT EXISTS ble_prompts_one_pending_trip_context
  ON ble_prompts (user_id, trip_id, stop_id) WHERE status = 'pending';

ALTER TABLE arrival_events ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id) ON DELETE RESTRICT;
ALTER TABLE arrival_events ADD COLUMN IF NOT EXISTS trip_direction text NOT NULL DEFAULT 'morning';
ALTER TABLE arrival_events DROP CONSTRAINT IF EXISTS arrival_events_bus_id_stop_id_trip_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS arrival_events_trip_stop_unique
  ON arrival_events (trip_id, stop_id) WHERE trip_id IS NOT NULL;

ALTER TABLE report_attempts ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id) ON DELETE RESTRICT;
ALTER TABLE report_attempts ADD COLUMN IF NOT EXISTS trip_direction text NOT NULL DEFAULT 'morning';
ALTER TABLE unmet_demand_events ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id) ON DELETE RESTRICT;
ALTER TABLE unmet_demand_events ADD COLUMN IF NOT EXISTS trip_direction text NOT NULL DEFAULT 'morning';
DROP INDEX IF EXISTS unmet_demand_trip_stop_bus_idx;
CREATE INDEX IF NOT EXISTS unmet_demand_trip_stop_bus_idx
  ON unmet_demand_events (trip_date DESC, trip_direction, stop_id, bus_id);
ALTER TABLE incharge_overrides ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id) ON DELETE RESTRICT;
ALTER TABLE incharge_overrides ADD COLUMN IF NOT EXISTS trip_direction text NOT NULL DEFAULT 'morning';
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id) ON DELETE RESTRICT;
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS trip_direction text;
ALTER TABLE auto_hold_evaluations ADD COLUMN IF NOT EXISTS trip_direction text NOT NULL DEFAULT 'morning';
ALTER TABLE auto_hold_evaluations DROP CONSTRAINT IF EXISTS auto_hold_evaluations_user_id_trip_date_context_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS auto_hold_evaluations_service_trip_unique
  ON auto_hold_evaluations (user_id, trip_date, trip_direction, context_key);

CREATE TABLE IF NOT EXISTS trip_closures (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL UNIQUE REFERENCES trips(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  final_base_occupied integer NOT NULL,
  final_manual_adjustment integer NOT NULL,
  final_seats_occupied integer NOT NULL,
  final_soft_holds integer NOT NULL,
  unresolved_soft_holds integer NOT NULL,
  timestamp timestamptz NOT NULL
);

COMMIT;

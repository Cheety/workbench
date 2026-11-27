CREATE TABLE events (
	id uuid PRIMARY KEY,
	sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
	name text NOT NULL CHECK (name <> ''),
	version integer NOT NULL CHECK (version >= 1),
	occurred_at timestamptz(3) NOT NULL,
	workspace_id uuid NOT NULL REFERENCES workspaces (id),
	payload jsonb NOT NULL
);

CREATE TABLE event_deliveries (
	event_id uuid NOT NULL REFERENCES events (id),
	subscriber text NOT NULL CHECK (subscriber <> ''),
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	next_attempt_at timestamptz(3) NOT NULL,
	delivered_at timestamptz(3),
	PRIMARY KEY (event_id, subscriber)
);

CREATE INDEX event_deliveries_pending_idx
	ON event_deliveries (next_attempt_at)
	WHERE delivered_at IS NULL;

CREATE TABLE jobs (
	id uuid PRIMARY KEY,
	name text NOT NULL CHECK (name <> ''),
	payload jsonb,
	workspace_id uuid REFERENCES workspaces (id),
	due_at timestamptz(3),
	enqueued_at timestamptz(3) NOT NULL,
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	next_attempt_at timestamptz(3) NOT NULL,
	state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed', 'dead')),
	settled_at timestamptz(3),
	failure_reason text CHECK (failure_reason <> ''),
	CHECK ((state = 'pending') = (settled_at IS NULL)),
	CHECK ((due_at IS NULL) <> (workspace_id IS NULL)),
	UNIQUE (name, due_at)
);

CREATE INDEX jobs_pending_idx
	ON jobs (next_attempt_at, id)
	WHERE state = 'pending';

CREATE TABLE idempotency_keys (
	actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'service_account')),
	actor_id text NOT NULL CHECK (actor_id <> ''),
	key text NOT NULL CHECK (key ~ '^[ -~]{1,255}$'),
	operation text NOT NULL CHECK (operation <> ''),
	workspace_id uuid NOT NULL REFERENCES workspaces (id),
	input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
	output json,
	created_at timestamptz(3) NOT NULL,
	PRIMARY KEY (actor_kind, actor_id, key)
);

CREATE INDEX idempotency_keys_created_at_idx
	ON idempotency_keys (created_at);

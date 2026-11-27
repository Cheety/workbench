CREATE TABLE audit_entries (
	id uuid PRIMARY KEY,
	occurred_at timestamptz(3) NOT NULL,
	actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'service_account')),
	actor_id text NOT NULL CHECK (actor_id <> ''),
	api_token_id uuid REFERENCES api_tokens (id),
	operation text NOT NULL CHECK (operation <> ''),
	workspace_id uuid NOT NULL REFERENCES workspaces (id),
	result text NOT NULL CHECK (result IN ('succeeded'))
);

CREATE INDEX audit_entries_workspace_id_occurred_at_id_idx
	ON audit_entries (workspace_id, occurred_at DESC, id DESC);

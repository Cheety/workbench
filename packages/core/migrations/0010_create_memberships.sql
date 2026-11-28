CREATE TABLE memberships (
	workspace_id uuid NOT NULL REFERENCES workspaces (id),
	actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'service_account')),
	actor_id text NOT NULL CHECK (actor_id <> ''),
	role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
	created_at timestamptz NOT NULL,
	PRIMARY KEY (workspace_id, actor_kind, actor_id)
);

CREATE TABLE service_accounts (
	id uuid PRIMARY KEY,
	name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
	created_at timestamptz NOT NULL
);

CREATE TABLE api_tokens (
	id uuid PRIMARY KEY,
	service_account_id uuid NOT NULL REFERENCES service_accounts (id),
	token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	created_at timestamptz NOT NULL,
	expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);

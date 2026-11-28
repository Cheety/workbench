ALTER TABLE api_tokens
	ADD COLUMN operations jsonb,
	ADD COLUMN workspaces jsonb,
	ADD COLUMN revoked_at timestamptz;

ALTER TABLE api_tokens
	ADD CONSTRAINT api_tokens_operations_check CHECK (
		operations IS NULL OR (jsonb_typeof(operations) = 'array' AND jsonb_array_length(operations) BETWEEN 1 AND 100)
	);

ALTER TABLE api_tokens
	ADD CONSTRAINT api_tokens_workspaces_check CHECK (
		workspaces IS NULL OR (jsonb_typeof(workspaces) = 'array' AND jsonb_array_length(workspaces) BETWEEN 1 AND 100)
	);

ALTER TABLE api_tokens
	ADD CONSTRAINT api_tokens_revoked_at_check CHECK (revoked_at IS NULL OR revoked_at >= created_at);

CREATE INDEX api_tokens_service_account_id_created_at_id_idx
	ON api_tokens (service_account_id, created_at DESC, id DESC);

ALTER TABLE audit_entries DROP CONSTRAINT audit_entries_reason_check;

ALTER TABLE audit_entries
	ADD CONSTRAINT audit_entries_reason_check CHECK (
		reason IN (
			'workspace_not_found',
			'missing_right',
			'object_not_found',
			'not_object_holder',
			'not_instance_admin',
			'operation_outside_token_scope',
			'workspace_outside_token_scope',
			'instance_outside_token_scope'
		)
	);

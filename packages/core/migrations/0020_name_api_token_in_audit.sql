ALTER TABLE audit_entries ADD COLUMN subject_api_token_id uuid;

ALTER TABLE audit_entries
	ADD CONSTRAINT audit_entries_subject_api_token_id_check CHECK (
		subject_api_token_id IS NULL OR result = 'succeeded'
	);

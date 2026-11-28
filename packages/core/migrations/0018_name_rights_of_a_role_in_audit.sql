ALTER TABLE audit_entries ADD COLUMN rights jsonb;

ALTER TABLE audit_entries
	ADD CONSTRAINT audit_entries_rights_check CHECK (
		rights IS NULL OR (result = 'succeeded' AND jsonb_typeof(rights) = 'array')
	);

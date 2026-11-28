ALTER TABLE audit_entries DROP CONSTRAINT audit_entries_result_check;

ALTER TABLE audit_entries
	ADD CONSTRAINT audit_entries_result_check CHECK (result IN ('succeeded', 'denied')) NOT VALID;

ALTER TABLE audit_entries VALIDATE CONSTRAINT audit_entries_result_check;

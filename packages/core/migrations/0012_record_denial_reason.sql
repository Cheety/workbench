ALTER TABLE audit_entries ADD COLUMN reason text;

ALTER TABLE audit_entries
	ADD CONSTRAINT audit_entries_reason_check CHECK (
		reason IN ('workspace_not_found', 'missing_right', 'object_not_found', 'not_object_holder')
	) NOT VALID;

ALTER TABLE audit_entries
	ADD CONSTRAINT audit_entries_reason_of_denial_check CHECK ((result = 'denied') = (reason IS NOT NULL)) NOT VALID;

ALTER TABLE audit_entries VALIDATE CONSTRAINT audit_entries_reason_check;

ALTER TABLE audit_entries VALIDATE CONSTRAINT audit_entries_reason_of_denial_check;

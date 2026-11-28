ALTER TABLE audit_entries
	ADD COLUMN member_kind text,
	ADD COLUMN member_id text,
	ADD COLUMN role_name text;

ALTER TABLE audit_entries
	ADD CONSTRAINT audit_entries_member_check CHECK (
		(member_kind IS NULL AND member_id IS NULL)
		OR (member_kind IN ('user', 'service_account') AND member_id <> '')
	) NOT VALID;

ALTER TABLE audit_entries
	ADD CONSTRAINT audit_entries_role_name_check CHECK (role_name ~ '^[a-z][a-z0-9-]{0,62}$') NOT VALID;

ALTER TABLE audit_entries
	ADD CONSTRAINT audit_entries_subject_of_success_check CHECK (
		result = 'succeeded' OR (member_kind IS NULL AND role_name IS NULL)
	) NOT VALID;

ALTER TABLE audit_entries VALIDATE CONSTRAINT audit_entries_member_check;

ALTER TABLE audit_entries VALIDATE CONSTRAINT audit_entries_role_name_check;

ALTER TABLE audit_entries VALIDATE CONSTRAINT audit_entries_subject_of_success_check;

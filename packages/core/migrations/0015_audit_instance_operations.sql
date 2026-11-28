ALTER TABLE audit_entries ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE audit_entries DROP CONSTRAINT audit_entries_reason_check;

ALTER TABLE audit_entries
	ADD CONSTRAINT audit_entries_reason_check CHECK (
		reason IN ('workspace_not_found', 'missing_right', 'object_not_found', 'not_object_holder', 'not_instance_admin')
	) NOT VALID;

ALTER TABLE audit_entries VALIDATE CONSTRAINT audit_entries_reason_check;

CREATE UNIQUE INDEX audit_entries_denial_per_minute_nulls_idx
	ON audit_entries (
		workspace_id,
		actor_kind,
		actor_id,
		operation,
		reason,
		(date_trunc('minute', occurred_at AT TIME ZONE 'UTC'))
	)
	NULLS NOT DISTINCT
	WHERE result = 'denied';

DROP INDEX audit_entries_denial_per_minute_idx;

CREATE INDEX audit_entries_occurred_at_id_idx
	ON audit_entries (occurred_at DESC, id DESC);

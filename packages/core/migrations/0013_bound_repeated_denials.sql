CREATE UNIQUE INDEX audit_entries_denial_per_minute_idx
	ON audit_entries (
		workspace_id,
		actor_kind,
		actor_id,
		operation,
		reason,
		(date_trunc('minute', occurred_at AT TIME ZONE 'UTC'))
	)
	WHERE result = 'denied';

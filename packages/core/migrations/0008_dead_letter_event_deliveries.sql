ALTER TABLE event_deliveries
	ADD COLUMN dead_lettered_at timestamptz(3),
	ADD COLUMN failure_reason text CHECK (failure_reason <> ''),
	ADD CONSTRAINT event_deliveries_settled_once_check
		CHECK (delivered_at IS NULL OR dead_lettered_at IS NULL),
	ADD CONSTRAINT event_deliveries_dead_letter_reason_check
		CHECK ((dead_lettered_at IS NULL) = (failure_reason IS NULL));

CREATE INDEX event_deliveries_open_idx
	ON event_deliveries (subscriber, event_sequence)
	WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;

DROP INDEX event_deliveries_pending_idx;

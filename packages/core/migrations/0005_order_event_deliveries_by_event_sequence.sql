ALTER TABLE event_deliveries ADD COLUMN event_sequence bigint;

UPDATE event_deliveries
SET event_sequence = events.sequence
FROM events
WHERE events.id = event_deliveries.event_id;

ALTER TABLE event_deliveries ALTER COLUMN event_sequence SET NOT NULL;

ALTER TABLE events ADD CONSTRAINT events_id_sequence_key UNIQUE (id, sequence);

ALTER TABLE event_deliveries
	ADD CONSTRAINT event_deliveries_event_fkey
	FOREIGN KEY (event_id, event_sequence) REFERENCES events (id, sequence);

ALTER TABLE event_deliveries DROP CONSTRAINT event_deliveries_event_id_fkey;

DROP INDEX event_deliveries_pending_idx;

CREATE INDEX event_deliveries_pending_idx
	ON event_deliveries (subscriber, event_sequence)
	WHERE delivered_at IS NULL;

ALTER TABLE notes
	ADD COLUMN holder_kind text CHECK (holder_kind IN ('user', 'service_account')),
	ADD COLUMN holder_id text CHECK (holder_id <> ''),
	ADD CONSTRAINT notes_holder_complete CHECK ((holder_kind IS NULL) = (holder_id IS NULL));

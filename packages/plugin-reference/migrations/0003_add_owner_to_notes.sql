ALTER TABLE notes
	ADD COLUMN owner_kind text CHECK (owner_kind IN ('user', 'service_account')),
	ADD COLUMN owner_id text CHECK (owner_id <> ''),
	ADD CONSTRAINT notes_owner_complete CHECK ((owner_kind IS NULL) = (owner_id IS NULL));

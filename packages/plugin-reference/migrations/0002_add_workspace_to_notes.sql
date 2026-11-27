ALTER TABLE notes ADD COLUMN workspace_id uuid NOT NULL;

CREATE INDEX notes_newest_first ON notes (workspace_id, created_at DESC, id DESC);

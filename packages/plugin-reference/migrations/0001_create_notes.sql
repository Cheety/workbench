CREATE TABLE notes (
	id uuid PRIMARY KEY,
	title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
	created_at timestamptz NOT NULL
);

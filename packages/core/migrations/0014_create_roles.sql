CREATE TABLE roles (
	name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9-]{0,62}$'),
	created_at timestamptz NOT NULL
);

INSERT INTO roles (name, created_at) VALUES ('owner', now()), ('editor', now()), ('viewer', now());

CREATE TABLE role_rights (
	role_name text NOT NULL REFERENCES roles (name) CHECK (role_name NOT IN ('owner', 'editor', 'viewer')),
	right_name text NOT NULL CHECK (right_name ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'),
	PRIMARY KEY (role_name, right_name)
);

ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;

ALTER TABLE memberships
	ADD CONSTRAINT memberships_role_fkey FOREIGN KEY (role) REFERENCES roles (name);

CREATE INDEX memberships_actor_idx
	ON memberships (actor_kind, actor_id);

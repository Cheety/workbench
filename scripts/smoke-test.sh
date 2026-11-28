#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${SMOKE_TEST_IMAGE:-workbench:smoke-test}"
work="$(mktemp -d)"
projects=(workbench-smoke-a workbench-smoke-b)
ports=(38081 38082)
workspace=00000000-0000-4000-8000-00000000aaaa

fail() {
	echo "smoke test failed: $*" >&2
	exit 1
}

compose() {
	local project=$1
	shift
	docker compose --project-directory "$root" --file "$root/compose.yaml" --env-file "$work/$project/.env" "$@"
}

cleanup() {
	local status=$?
	for project in "${projects[@]}"; do
		[ -f "$work/$project/.env" ] || continue
		if [ "$status" -ne 0 ]; then compose "$project" logs --no-color >&2 || true; fi
		compose "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
	done
	rm -rf "$work"
	exit "$status"
}
trap cleanup EXIT

prepare() {
	local project=$1 port=$2 password
	password="$(openssl rand -hex 24)"
	mkdir -p "$work/$project/secrets"
	chmod 700 "$work/$project/secrets"
	printf '%s\n' "$password" > "$work/$project/secrets/postgres_password"
	printf 'postgres://workbench:%s@postgres:5432/workbench\n' "$password" > "$work/$project/secrets/database_url"
	chmod 644 "$work/$project/secrets/"*
	cat > "$work/$project/.env" <<-EOF
		COMPOSE_PROJECT_NAME=$project
		WORKBENCH_IMAGE=$image
		WORKBENCH_PORT=$port
		SECRETS_DIRECTORY=$work/$project/secrets
		PLUGINS=reference
	EOF
}

psql_in() {
	compose "$1" exec -T postgres psql --username workbench --dbname workbench --tuples-only --no-align --command "$2"
}

create_token() {
	compose "$1" exec -T workbench bun run --silent create-service-account --name smoke --valid-days 1 |
		sed -E 's/.*"token":"([^"]+)".*/\1/'
}

create_note() {
	curl --silent --output "$work/$1.note" --write-out '%{http_code}' \
		--request POST "http://127.0.0.1:$2/api/workspaces/$workspace/operations/reference.createNote" \
		--header "Authorization: Bearer $3" --data '{"title":"Smoke"}'
}

docker build --tag "$image" "$root"

user="$(docker image inspect --format '{{.Config.User}}' "$image")"
case "${user%%:*}" in
	"" | root | 0) fail "image runs as root (user '$user')" ;;
esac
if docker image inspect --format '{{json .Config.Env}}' "$image" | grep -Eq 'DATABASE_URL|PASSWORD|SECRET|TOKEN'; then
	fail "image environment names a secret"
fi
container="$(docker create "$image")"
files="$(docker export "$container" | tar -t)"
docker rm "$container" >/dev/null
if grep -Eq '(^|/)\.env$|(^|/)secrets/' <<<"$files"; then fail "image contains an env file or secrets"; fi
if grep -Eq '^app/packages/.*\.test\.ts$' <<<"$files"; then fail "image contains tests"; fi

for index in "${!projects[@]}"; do
	prepare "${projects[$index]}" "${ports[$index]}"
	compose "${projects[$index]}" up --detach --wait --wait-timeout 180
done

expected_migrations="$(
	{
		for file in "$root"/packages/core/migrations/*.sql; do echo "core/$(basename "$file")"; done
		for file in "$root"/packages/plugin-reference/migrations/*.sql; do echo "plugin_reference/$(basename "$file")"; done
	} | sort
)"

declare -A tokens
for index in "${!projects[@]}"; do
	project="${projects[$index]}"
	port="${ports[$index]}"

	ready="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/health/ready")"
	[ "$ready" = 200 ] || fail "$project answers /health/ready with $ready"

	uid="$(compose "$project" exec -T workbench id -u)"
	[ "$uid" != 0 ] || fail "$project runs its container as root"

	applied="$(psql_in "$project" "SELECT schema_name || '/' || migration FROM core.migrations ORDER BY 1")"
	[ "$applied" = "$expected_migrations" ] || fail "$project applied migrations $applied, expected $expected_migrations"

	psql_in "$project" "INSERT INTO core.workspaces (id, name, created_at) VALUES ('$workspace', 'Smoke', now())" >/dev/null
	tokens[$project]="$(create_token "$project")"

	status="$(create_note "$project" "$port" "${tokens[$project]}")"
	[ "$status" = 200 ] || fail "$project answers reference.createNote with $status: $(cat "$work/$project.note")"
	grep -q '"title":"Smoke"' "$work/$project.note" || fail "$project returned $(cat "$work/$project.note")"
done

foreign="$(create_note "${projects[1]}" "${ports[1]}" "${tokens[${projects[0]}]}")"
[ "$foreign" = 401 ] || fail "${projects[1]} accepts a token of ${projects[0]} with $foreign"

for kind in volume network; do
	first="$(docker "$kind" ls --quiet --filter "label=com.docker.compose.project=${projects[0]}" | sort)"
	second="$(docker "$kind" ls --quiet --filter "label=com.docker.compose.project=${projects[1]}" | sort)"
	[ -n "$first" ] && [ -n "$second" ] || fail "a project has no $kind of its own"
	[ -z "$(comm -12 <(echo "$first") <(echo "$second"))" ] || fail "both projects share a $kind"
done

echo "smoke test passed"

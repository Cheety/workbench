#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${SMOKE_TEST_IMAGE:-workbench:smoke-test}"
projects=(workbench-smoke-a workbench-smoke-b)
ports=("${SMOKE_TEST_PORT_A:-38081}" "${SMOKE_TEST_PORT_B:-38082}")
workspace=00000000-0000-4000-8000-00000000aaaa
work=""
container=""
image_built=""
curl_limits=(--show-error --connect-timeout 5 --max-time 30)

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
	if [ -n "$work" ]; then
		for project in "${projects[@]}"; do
			[ -f "$work/$project/.env" ] || continue
			if [ "$status" -ne 0 ]; then compose "$project" logs --no-color >&2 || true; fi
			compose "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
		done
		rm -rf "$work"
	fi
	if [ -n "$container" ]; then docker rm --force "$container" >/dev/null 2>&1 || true; fi
	if [ -n "$image_built" ]; then docker image rm --force "$image" >/dev/null 2>&1 || true; fi
	exit "$status"
}
trap cleanup EXIT

for tool in docker curl jq openssl; do
	command -v "$tool" >/dev/null || fail "$tool is not installed"
done
work="$(mktemp -d)"

plugins=()
expected_migrations="$(for file in "$root"/packages/core/migrations/*.sql; do echo "core/$(basename "$file")"; done)"
for manifest in "$root"/packages/*/package.json; do
	plugin="$(jq --raw-output '.workbench.plugin.name // empty' "$manifest")"
	[ -n "$plugin" ] || continue
	plugins+=("$plugin")
	migrations="$(jq --raw-output '.workbench.plugin.migrations // empty' "$manifest")"
	[ -n "$migrations" ] || continue
	for file in "$(dirname "$manifest")/$migrations"/*.sql; do
		if [ -f "$file" ]; then expected_migrations+=$'\n'"plugin_${plugin//-/_}/$(basename "$file")"; fi
	done
done
expected_migrations="$(LC_ALL=C sort <<<"$expected_migrations")"
[[ " ${plugins[*]} " == *" reference "* ]] || fail "no plugin package provides the plugin reference"
enabled_plugins="$(IFS=,; echo "${plugins[*]}")"

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
		PLUGINS=$enabled_plugins
	EOF
}

psql_in() {
	compose "$1" exec -T postgres psql --username workbench --dbname workbench --tuples-only --no-align --command "$2"
}

create_token() {
	local output token
	output="$(compose "$1" exec -T workbench bun run --silent create-service-account --name smoke --valid-days 1)"
	token="$(jq --raw-output '.token // empty' <<<"$output" 2>/dev/null)" || token=""
	[ -n "$token" ] || fail "$1 printed no token field in the JSON output of create-service-account"
	echo "$token"
}

create_note() {
	curl "${curl_limits[@]}" --silent --output "$work/$1.note" --write-out '%{http_code}' \
		--request POST "http://127.0.0.1:$2/api/workspaces/$workspace/operations/reference.createNote" \
		--header "Authorization: Bearer $3" --data '{"title":"Smoke"}'
}

bun_version="$(tr -d '[:space:]' < "$root/.bun-version")"
grep -q "oven/bun:$bun_version-slim@" "$root/Dockerfile" || fail "Dockerfile does not build on Bun $bun_version from .bun-version"
if docker image inspect "$image" >/dev/null 2>&1; then fail "image $image exists already; set SMOKE_TEST_IMAGE to an unused name"; fi
image_built=yes
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
if grep -Eq '(^|/)\.env$|(^|/)secrets/' <<<"$files"; then fail "image contains an env file or secrets"; fi
if grep -Eq '^app/packages/.*\.test\.ts$' <<<"$files"; then fail "image contains tests"; fi

for index in "${!projects[@]}"; do
	prepare "${projects[$index]}" "${ports[$index]}"
	compose "${projects[$index]}" up --detach --wait --wait-timeout 180
done

declare -A tokens
for index in "${!projects[@]}"; do
	project="${projects[$index]}"
	port="${ports[$index]}"

	ready="$(curl "${curl_limits[@]}" --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/health/ready")"
	[ "$ready" = 200 ] || fail "$project answers /health/ready with $ready"

	uid="$(compose "$project" exec -T workbench id -u)"
	[ "$uid" != 0 ] || fail "$project runs its container as root"

	applied="$(psql_in "$project" "SELECT entry FROM (SELECT schema_name || '/' || migration AS entry FROM core.migrations) AS applied ORDER BY entry COLLATE \"C\"")"
	[ "$applied" = "$expected_migrations" ] || fail "$project applied migrations $applied, expected $expected_migrations"

	psql_in "$project" "INSERT INTO core.workspaces (id, name, created_at) VALUES ('$workspace', 'Smoke', now())" >/dev/null
	tokens[$project]="$(create_token "$project")"

	status="$(create_note "$project" "$port" "${tokens[$project]}")"
	[ "$status" = 200 ] || fail "$project answers reference.createNote with $status: $(cat "$work/$project.note")"
	grep -q '"title":"Smoke"' "$work/$project.note" || fail "$project returned $(cat "$work/$project.note")"
done

foreign="$(create_note "${projects[1]}" "${ports[1]}" "${tokens[${projects[0]}]}")"
[ "$foreign" = 401 ] || fail "${projects[1]} accepts a token of ${projects[0]} with $foreign"

resources_in_use() {
	local containers
	mapfile -t containers < <(compose "$1" ps --quiet)
	docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}volume {{.Name}}{{println}}{{end}}{{end}}{{range $network, $_ := .NetworkSettings.Networks}}network {{$network}}{{println}}{{end}}' "${containers[@]}" | sed '/^$/d' | LC_ALL=C sort -u
}

for project in "${projects[@]}"; do
	used="$(resources_in_use "$project")"
	expected="$(printf '%s\n' "network ${project}_database" "network ${project}_default" "volume ${project}_postgres-data" | LC_ALL=C sort)"
	[ "$used" = "$expected" ] || fail "$project uses $used, expected only its own $expected"
done

echo "smoke test passed"

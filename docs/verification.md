# Verifikation

Wie man die Workbench lokal startet und treibt, um zu zeigen, dass eine Änderung wirkt. Jeder Befehl läuft im Wurzelverzeichnis des Repos nach `bun install`. Jedes Rezept steht für sich, weil die Shell-Befehle eines Agenten keine Variablen teilen: Log und PID liegen deshalb in Dateien unter `/tmp`.

Findet die Shell `bun` nicht, liegt es meist in `~/.bun/bin`: `export PATH="$HOME/.bun/bin:$PATH"` vor den Befehl stellen.

## Datenbank starten

```sh
docker compose -f compose.dev.yaml up --detach --wait
```

Postgres 17 lauscht auf `127.0.0.1:54329`, Nutzer und Passwort `workbench`, und hält alles nur im Arbeitsspeicher. Die Tests legen sich darin eigene Datenbanken an. Für einen Server von Hand eine eigene anlegen, damit Migrationen und Daten getrennt bleiben:

```sh
docker compose -f compose.dev.yaml exec -T postgres psql -U workbench -d workbench_test -c 'CREATE DATABASE workbench_verify'
```

Ein zweites `CREATE DATABASE` scheitert mit `already exists`; dann ist sie schon da.

Postgres bietet TLS an, mit einem selbst signierten Zertifikat, das nur `localhost` nennt, nicht `127.0.0.1`. Der Container erzeugt Zertifikat und Schlüssel bei jedem Start neu und behält beide für sich; auf dem Rechner liegt nichts davon. Die Tests in `packages/core/src/transaction-deadline.test.ts` lesen das Zertifikat per `pg_read_file(current_setting('ssl_cert_file'))` vom Server, schreiben es in eine temporäre Datei, übergeben sie als `sslrootcert` und prüfen so jeden `sslmode` gegen einen echten TLS-Server. Bietet der Server kein TLS an, scheitern sie mit `TestDatabaseWithoutTlsError`. Ein Container, der vor dieser Einstellung in `compose.dev.yaml` gestartet wurde, muss einmal neu erzeugt werden:

```sh
docker compose -f compose.dev.yaml up --detach --wait --force-recreate
```

Die übrigen Tests verbinden sich ohne `sslmode` und damit ohne TLS.

## Prüfen

```sh
bun run check
```

Format und Lint, Typen, alle Tests samt Architekturtests; derselbe Befehl läuft in der CI. Während der Arbeit eine Datei oder einen Test gezielt:

```sh
bun test packages/core/src/kernel.test.ts
bun test packages/core/src/kernel.test.ts -t "activates required plugins first"
```

`-t` filtert nach dem Namen aus `describe` und `test`.

## Server starten

```sh
DATABASE_URL=postgres://workbench:workbench@127.0.0.1:54329/workbench_verify PORT=3123 PLUGINS=reference bun packages/core/src/main.ts > /tmp/workbench-verify.log 2>&1 & echo $! > /tmp/workbench-verify.pid
```

Der Server läuft im Hintergrund, bis er gestoppt wird. Ist der Start fertig, endet das Log mit diesen Einträgen (eine JSON-Zeile je Eintrag, hier gekürzt):

```json
{"level":"info","message":"server started","port":3123}
{"level":"info","message":"migration applied","schema":"core","migration":"0001_create_workspaces.sql"}
{"level":"info","message":"plugins discovered","packages":["@workbench/plugin-reference"]}
{"level":"info","message":"plugins resolved","activationOrder":["reference"]}
{"level":"info","message":"migration applied","schema":"plugin_reference","migration":"0001_create_notes.sql"}
{"level":"info","message":"migration applied","schema":"plugin_reference","migration":"0002_add_workspace_to_notes.sql"}
{"level":"info","message":"plugin activated","plugin":"reference","version":"0.1.0"}
{"level":"info","message":"plugins started","active":["reference"],"notLoaded":[]}
{"level":"info","message":"instance started"}
```

`migration applied` erscheint nur beim ersten Start gegen eine Datenbank. Fehlt `instance started`, ist der Start noch nicht fertig oder gescheitert: das Log erneut lesen.

## Health prüfen

```sh
curl -si http://127.0.0.1:3123/health/ready
curl -si http://127.0.0.1:3123/health/live -H 'X-Correlation-ID: verify-1'
```

`ready` antwortet `200 {"status":"ready"}` nach `instance started`, sonst `503 {"status":"not_ready"}`; `live` antwortet immer `200 {"status":"alive"}`. Jede Antwort trägt `X-Correlation-ID`, mit `verify-1` übernommen, ohne Header neu erzeugt.

## Migrationen und Schema ansehen

```sh
docker compose -f compose.dev.yaml exec -T postgres psql -U workbench -d workbench_verify -c 'TABLE core.migrations' -c '\dt plugin_reference.*'
```

`core.migrations` hat die Spalten `schema_name`, `migration` und `applied_at`; dort stehen `core | 0001_create_workspaces.sql` und für das Referenz-Plugin `plugin_reference | 0001_create_notes.sql` und `plugin_reference | 0002_add_workspace_to_notes.sql`, und `\dt` zeigt dessen Tabelle `notes`.

## Ein Event in der Outbox ansehen

Den Server wie oben mit `PLUGINS=reference` starten. Dann einen Workspace und ein API-Token anlegen, das Token liegt danach in `/tmp/workbench-verify.token`:

```sh
docker compose -f compose.dev.yaml exec -T postgres psql -U workbench -d workbench_verify -c "INSERT INTO core.workspaces (id, name, created_at) VALUES ('00000000-0000-4000-8000-00000000aaaa', 'Verify', now())"
DATABASE_URL=postgres://workbench:workbench@127.0.0.1:54329/workbench_verify bun packages/core/src/create-service-account.ts --name verify --valid-days 1 | sed -E 's/.*"token":"([^"]+)".*/\1/' > /tmp/workbench-verify.token
```

Eine Mutation aufrufen, die ein Event publiziert, und die Outbox ansehen:

```sh
curl -s -X POST http://127.0.0.1:3123/api/workspaces/00000000-0000-4000-8000-00000000aaaa/operations/reference.createNote -H "Authorization: Bearer $(cat /tmp/workbench-verify.token)" -d '{"title":"Plan"}'
docker compose -f compose.dev.yaml exec -T postgres psql -U workbench -d workbench_verify -c 'SELECT name, version, payload FROM core.events' -c 'TABLE core.event_deliveries'
```

Die Migration `0007_index_events_by_occurred_at.sql` legt den Index `events_occurred_at_idx` an, über den der Core Events nach ihrer Aufbewahrungsfrist von 7 Tagen findet und löscht; `SELECT indexname FROM pg_indexes WHERE schemaname = 'core' AND tablename = 'events'` nennt ihn. `core.events` nennt `reference.NoteCreated` in Version 1 mit der `noteId` der Antwort. `core.event_deliveries` bleibt leer, solange kein in `PLUGINS` aktiviertes Plugin das Event abonniert; mit einem abonnierenden Plugin steht dort je Plugin eine Zeile mit `attempts`, `delivered_at` und, für eine aufgegebene Zustellung im Dead-Letter, `dead_lettered_at` mit `failure_reason`, und mit `LOG_LEVEL=debug` meldet das Log `event delivered`, sonst nur `event not delivered`, nach dem 25. Versuch `event dead-lettered` und nach der Zustellfrist von 30 Tagen `event deliveries expired`, jeweils mit `reason`. Wie ein Handler ein Event erhält und eine gescheiterte Zustellung wiederholt wird, zeigen die Tests in `packages/core/src/events.test.ts`; wie sie im Dead-Letter landet und danach gelöscht wird, mit einer Uhr, die der Test stellt, die in `packages/core/src/event-outbox.test.ts`.

Die Migration `0008_dead_letter_event_deliveries.sql` ergänzt `core.event_deliveries` um die Spalten `dead_lettered_at` und `failure_reason` und ersetzt den partiellen Index `event_deliveries_pending_idx` durch `event_deliveries_open_idx`, der nur Zustellungen umfasst, die weder gelungen noch im Dead-Letter sind:

```sh
docker compose -f compose.dev.yaml exec -T postgres psql -U workbench -d workbench_verify -c "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'core' AND tablename = 'event_deliveries'" -c '\d core.event_deliveries'
```

Die Ausgabe nennt neben dem Primärschlüssel `event_deliveries_open_idx` auf `(subscriber, event_sequence)` mit `WHERE delivered_at IS NULL AND dead_lettered_at IS NULL`, aber nicht mehr `event_deliveries_pending_idx`; `\d` zeigt die Check-Constraints `event_deliveries_settled_once_check` und `event_deliveries_dead_letter_reason_check`.

## Die Job-Queue ansehen

Den Server wie oben starten. Die Migration `0006_create_jobs.sql` hat `core.jobs` angelegt:

```sh
docker compose -f compose.dev.yaml exec -T postgres psql -U workbench -d workbench_verify -c 'SELECT name, state, attempts, next_attempt_at, due_at, failure_reason FROM core.jobs ORDER BY next_attempt_at'
```

Dieselbe Migration legt zwei Indizes an: `jobs_pending_idx` für die Suche nach fälligen Jobs und `jobs_settled_idx` für das Löschen abgelaufener erledigter und toter Jobs.

```sh
docker compose -f compose.dev.yaml exec -T postgres psql -U workbench -d workbench_verify -c "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'core' AND tablename = 'jobs'"
```

Die Ausgabe nennt neben dem Primärschlüssel und `jobs_name_due_at_key` beide Indizes; `jobs_settled_idx` liegt auf `(state, settled_at)` und umfasst nur Zeilen mit `settled_at`.

Dort steht immer der Cron-Job des Cores `core.removeExpiredIdempotencyKeys` mit seiner nächsten Fälligkeit in `due_at`, alle zehn Minuten; das Referenz-Plugin reiht keine Jobs ein und deklariert keinen Cron-Job. Mit einem Plugin, das es tut, steht dort je Job eine Zeile (`pending`, `completed` oder `dead`), für einen Cron-Job die nächste Fälligkeit in `due_at`, und mit `LOG_LEVEL=debug` meldet das Log `job completed`, sonst nur `job failed` und `job dead-lettered` mit `reason`. Wie ein Job nach dem Festschreiben läuft, wiederholt wird, seine Frist überschreitet und im Dead-Letter landet, zeigen die Tests in `packages/core/src/jobs.test.ts` und `packages/core/src/job-queue.test.ts`, mit einer Uhr, die der Test stellt.

## Einen Idempotency-Key ansehen

Den Server, den Workspace und das Token wie unter [Ein Event in der Outbox ansehen](#ein-event-in-der-outbox-ansehen) anlegen. Dieselbe Mutation zweimal mit demselben Key aufrufen, dann einmal mit anderer Eingabe:

```sh
for title in Plan Plan Other; do curl -s -X POST http://127.0.0.1:3123/api/workspaces/00000000-0000-4000-8000-00000000aaaa/operations/reference.createNote -H "Authorization: Bearer $(cat /tmp/workbench-verify.token)" -H 'Idempotency-Key: verify-1' -d "{\"title\":\"$title\"}"; echo; done
docker compose -f compose.dev.yaml exec -T postgres psql -U workbench -d workbench_verify -c 'SELECT key, operation, output, created_at FROM core.idempotency_keys' -c 'SELECT count(*) FROM plugin_reference.notes'
```

Die ersten beiden Antworten sind gleich, mit derselben `id`; die dritte ist Problem Details mit Status 422 und `code` `idempotency_key_reused`. `core.idempotency_keys` hat eine Zeile mit dem Key `verify-1`, `reference.createNote` und der Antwort als JSON, und `plugin_reference.notes` hat genau eine Notiz. Dass der Cron-Job den Key nach 24 Stunden löscht und dass zwei gleichzeitige Aufrufe nur einmal ausführen, zeigen die Tests in `packages/core/src/idempotency-keys.test.ts`, mit einer Uhr, die der Test stellt.

## Ein Tool per MCP aufrufen

Den Server, den Workspace und das Token wie unter [Ein Event in der Outbox ansehen](#ein-event-in-der-outbox-ansehen) anlegen. Dann die Tools listen und die Referenz-Mutation als Tool aufrufen, einmal gültig und einmal mit leerem Titel:

```sh
for body in '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"reference_createNote","arguments":{"workspace":"00000000-0000-4000-8000-00000000aaaa","input":{"title":"Plan"}}}}' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"reference_createNote","arguments":{"workspace":"00000000-0000-4000-8000-00000000aaaa","input":{"title":""}}}}'; do curl -s http://127.0.0.1:3123/api/mcp -H "Authorization: Bearer $(cat /tmp/workbench-verify.token)" -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -H 'MCP-Protocol-Version: 2025-11-25' -d "$body"; echo; done
curl -si http://127.0.0.1:3123/api/mcp -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":4,"method":"tools/list"}' | head -1
```

`tools/list` nennt `core_listAuditEntries`, `reference_createNote` und `reference_listNotes`, jedes mit `workspace` und `input` im `inputSchema`. Der erste Aufruf antwortet mit einem Textblock, der die Notiz als JSON enthält, wie der Body von `POST …/operations/reference.createNote`; der zweite mit `isError: true` und Problem Details mit `code` `invalid_input`. Ohne Token antwortet der Endpunkt mit `401 Unauthorized`.

## Eine Operation per CLI aufrufen

Den Server, den Workspace und das Token wie unter [Ein Event in der Outbox ansehen](#ein-event-in-der-outbox-ansehen) anlegen. Dann die Operationen listen, die Referenz-Mutation aufrufen, einmal gültig, einmal mit leerem Titel und einmal mit einer Eingabe, die kein JSON ist, und jeweils den Exit-Code ausgeben:

```sh
export WORKBENCH_URL=http://127.0.0.1:3123 WORKBENCH_TOKEN="$(cat /tmp/workbench-verify.token)"
bun run --silent workbench operations; echo "exit $?"
bun run --silent workbench reference create-note --workspace 00000000-0000-4000-8000-00000000aaaa --input '{"title":"Plan"}'; echo "exit $?"
bun run --silent workbench reference create-note --workspace 00000000-0000-4000-8000-00000000aaaa --input '{"title":""}'; echo "exit $?"
bun run --silent workbench reference create-note --workspace 00000000-0000-4000-8000-00000000aaaa --input '{title'; echo "exit $?"
curl -s http://127.0.0.1:3123/api/operations -H "Authorization: Bearer $WORKBENCH_TOKEN"
```

Die Liste nennt `core list-audit-entries`, `reference create-note` und `reference list-notes`, je mit dem Namen der Operation und ihrer Art, wie `GET /api/operations`; `exit 0`. Der erste Aufruf gibt die Notiz als JSON aus, wie der Body von `POST …/operations/reference.createNote`, mit `exit 0`; der zweite `invalid_input: …`, darunter `title: Too small: …` und die Korrelations-ID, mit `exit 1`; der dritte `--input is not JSON` und die Zeile `usage: workbench …`, mit `exit 2`, und das Log des Servers hat dafür keinen Eintrag `request completed`. Ohne `WORKBENCH_TOKEN` und ohne `~/.config/workbench/cli.json` endet jeder Aufruf mit `invalid configuration:` und `exit 2`; `grep -c "$WORKBENCH_TOKEN" /tmp/workbench-verify.log` zählt `0`.

## Image und Compose prüfen

```sh
scripts/smoke-test.sh
```

Das Skript baut das Image als `workbench:smoke-test` (anderer Name über `SMOKE_TEST_IMAGE`; existiert ein Image dieses Namens schon, bricht es mit `smoke test failed: image … exists already` ab), startet die Compose-Projekte `workbench-smoke-a` und `workbench-smoke-b` auf `127.0.0.1:38081` und `127.0.0.1:38082` (andere Ports über `SMOKE_TEST_PORT_A` und `SMOKE_TEST_PORT_B`) mit frischen Volumes und eigenen Secrets in einem temporären Verzeichnis, prüft sie und entfernt beide samt Volumes, das temporäre Verzeichnis und das Image, auch wenn es scheitert. Es braucht `docker`, `curl`, `jq` und `openssl`. Die letzte Zeile ist `smoke test passed`; sonst `smoke test failed: …`, davor die Logs beider Projekte. Die Ports müssen frei sein.

Eine Instanz von Hand, wie unter „Betrieb mit Docker Compose“ in der README, aber als eigenes Projekt mit Secrets unter `/tmp`:

```sh
docker build --tag workbench:local .
mkdir -p -m 700 /tmp/workbench-compose/secrets && openssl rand -hex 24 > /tmp/workbench-compose/secrets/postgres_password && printf 'postgres://workbench:%s@postgres:5432/workbench\n' "$(cat /tmp/workbench-compose/secrets/postgres_password)" > /tmp/workbench-compose/secrets/database_url && chmod 644 /tmp/workbench-compose/secrets/*
sed -e 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=workbench-verify/' -e 's/^WORKBENCH_PORT=.*/WORKBENCH_PORT=38080/' -e 's|^SECRETS_DIRECTORY=.*|SECRETS_DIRECTORY=/tmp/workbench-compose/secrets|' .env.example > /tmp/workbench-compose/.env
docker compose --env-file /tmp/workbench-compose/.env up --detach --wait
curl -si http://127.0.0.1:38080/health/ready
docker compose --env-file /tmp/workbench-compose/.env logs workbench
```

`up --wait` kehrt zurück, wenn beide Container `healthy` sind; `ready` antwortet `200 {"status":"ready"}`, und das Log endet mit `instance started`, wie unter [Server starten](#server-starten). Abräumen samt Volume:

```sh
docker compose --env-file /tmp/workbench-compose/.env down --volumes && rm -rf /tmp/workbench-compose
```

## Einen Ladefehler auslösen

Ein Plugin in `PLUGINS`, das kein Plugin-Paket bereitstellt, ist der schnellste Ladefehler. Den Server wie oben starten, aber mit `PLUGINS=reference,missing`, dann:

```sh
grep -E '"plugin not loaded"|"plugins started"' /tmp/workbench-verify.log
```

Das Log nennt `"reason":"unknown_plugin"` mit `detail`, und `plugins started` führt `"notLoaded":["missing"]`; `reference` ist trotzdem aktiv. Die übrigen Gründe und ihre Bedeutung stehen in der Tabelle der README. Einen Grund, für den es kein solches Rezept gibt, zeigt der Test im Kernel, der ihn auslöst.

## Ohne Datenbank starten

```sh
DATABASE_URL=postgres://workbench:workbench@127.0.0.1:1/none PORT=3123 bun packages/core/src/main.ts > /tmp/workbench-verify.log 2>&1 & echo $! > /tmp/workbench-verify.pid
```

Der Server startet, `/health/ready` antwortet `503`, `/health/live` `200`, und das Log wiederholt `database unreachable, retrying` mit `reason` und `retryInMs`, bis Postgres erreichbar ist oder der Prozess gestoppt wird.

## Ungültige Konfiguration

```sh
PORT=abc bun packages/core/src/main.ts; echo "exit $?"
```

Der Prozess endet sofort mit `exit 1` und einem Eintrag `invalid configuration, not starting`, dessen `issues` jede ungültige Variable mit `problem` nennen, hier `DATABASE_URL` (fehlt) und `PORT`; Werte erscheinen nie im Log.

## Stoppen

```sh
kill -TERM "$(cat /tmp/workbench-verify.pid)"
```

Das Log endet mit `shutting down` (`"signal":"SIGTERM"`) und je einem `plugin deactivated`, in umgekehrter Aktivierungsreihenfolge. Den Prozess über seine PID stoppen, nicht per `pkill`: auf dem Rechner laufen oft weitere `bun`-Prozesse.

Die Datenbank des Servers entfernen, oder gleich das ganze Postgres:

```sh
docker compose -f compose.dev.yaml exec -T postgres psql -U workbench -d workbench_test -c 'DROP DATABASE workbench_verify WITH (FORCE)'
docker compose -f compose.dev.yaml down
```

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

Die Tabelle bleibt leer, solange kein aktives Plugin einen Job einreiht oder einen Cron-Job deklariert; das Referenz-Plugin tut beides nicht. Mit einem solchen Plugin steht dort je Job eine Zeile (`pending`, `completed` oder `dead`), für einen Cron-Job die nächste Fälligkeit in `due_at`, und mit `LOG_LEVEL=debug` meldet das Log `job completed`, sonst nur `job failed` und `job dead-lettered` mit `reason`. Wie ein Job nach dem Festschreiben läuft, wiederholt wird, seine Frist überschreitet und im Dead-Letter landet, zeigen die Tests in `packages/core/src/jobs.test.ts` und `packages/core/src/job-queue.test.ts`, mit einer Uhr, die der Test stellt.

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

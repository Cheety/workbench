# Workbench

Selbst gehostete, erweiterbare Arbeitsoberfläche. Begriffe stehen in [`GLOSSARY.md`](GLOSSARY.md), Entscheidungen in [`docs/adr/`](docs/adr/).

Das Repository ist ein Bun-Monorepo. Der Core-Server liegt in `packages/core`, das SDK für Plugins in `packages/sdk`, jedes Plugin-Paket in einem eigenen Verzeichnis unter `packages/` (zuerst das Referenz-Plugin in `packages/plugin-reference`). Die Architekturtests liegen in `packages/architecture`.

## Voraussetzungen

- [Bun](https://bun.sh) in der Version aus `.bun-version`
- Docker mit Compose für die Test-Datenbank

```sh
bun install
```

## Test-Datenbank

Die Integrationstests laufen gegen ein echtes Postgres 17. Lokal startet es so:

```sh
docker compose -f compose.dev.yaml up --detach --wait
```

Die Datenbank lauscht auf `127.0.0.1:54329`, hält ihre Daten nur im Arbeitsspeicher und wird mit `docker compose -f compose.dev.yaml down` wieder entfernt. Sie bietet TLS mit einem selbst signierten Zertifikat für `localhost` an, das der Container bei jedem Start neu erzeugt und für sich behält; die Tests der Verbindung, die Anweisungen abbricht, lesen es per `pg_read_file` vom Server und scheitern mit `TestDatabaseWithoutTlsError`, wenn der Server kein TLS anbietet. Ein Container, der vor dieser Einstellung gestartet wurde, muss einmal mit `docker compose -f compose.dev.yaml up --detach --wait --force-recreate` neu erzeugt werden. Eine andere Datenbank lässt sich über `TEST_DATABASE_URL` angeben. `compose.dev.yaml` dient nur der Entwicklung und ist keine Deployment-Datei.

## Prüfbefehl

```sh
bun run check
```

Der Befehl prüft Format und Lint (Biome), Typen (`tsc`) und führt die Tests aus, darunter die Architekturtests (siehe [Contract](#contract) und ADR-0009). Der Workflow `ci` ruft genau diesen Befehl für jede Pull-Request und jeden Push auf `main` auf. `bun run format` behebt Format- und Lint-Befunde, soweit das automatisch geht.

## Server starten

```sh
DATABASE_URL=postgres://workbench:workbench@127.0.0.1:54329/workbench_test bun run --filter @workbench/core start
```

- `GET /health/live` meldet, dass der Prozess läuft, unabhängig von der Datenbank.
- `GET /health/ready` antwortet mit 200, wenn der Start der Instanz abgeschlossen ist und Postgres erreichbar ist, sonst mit 503. Der Server startet auch ohne Datenbank.

Beim Start wartet die Instanz ohne Obergrenze, bis Postgres erreichbar ist (Log-Eintrag `database unreachable, retrying` mit `reason` und `retryInMs`; die Wartezeit wächst exponentiell mit Zufallsanteil bis höchstens 10 s; Begründung in ADR-0008). Danach migriert sie das Schema `core` und die Schemas der Plugins (siehe [Migrationen](#migrationen)), aktiviert die Plugins und meldet `instance started`; erst dann ist sie bereit. Schlägt eine Migration fehl, meldet das Log `instance failed to start` mit `reason` (`core_schema_not_migrated` oder `plugin_schema_not_migrated`), und die Instanz bleibt bis zum nächsten Start „nicht bereit“; die HTTP-API antwortet dann mit 503 (`instance_not_ready`).

Kann der Server nicht starten, etwa weil der Port belegt ist, endet der Prozess mit Exit-Code 1 und einem Log-Eintrag `server failed to start`, der Port und Fehlercode (z. B. `EADDRINUSE`) nennt.

Eine unbekannte Route beantwortet der Server mit 404 als Problem Details (`route_not_found`, siehe [HTTP-API](#http-api)). Scheitert eine Anfrage außerhalb einer Operation, etwa weil Postgres beim Prüfen des Tokens nicht antwortet, antwortet er mit 500 (`internal_error`) und neutraler Meldung; das Log nennt den Fehler mit Name, Meldung und Stacktrace im Eintrag `request failed`.

Logs sind JSON-Zeilen auf der Standardausgabe. Jede Anfrage trägt eine Korrelations-ID: Ein gültiger Header `X-Correlation-ID` (höchstens 128 Zeichen aus Buchstaben, Ziffern, `.`, `_`, `-`) wird übernommen, sonst erzeugt der Server eine. Die Antwort nennt sie im selben Header.

## Plugins

Ein Plugin-Paket ist ein Paket unter `packages/`, dessen `package.json` unter `workbench.plugin` den Namen des Plugins und den Pfad seines Einstiegs nennt:

```json
{
	"name": "@workbench/plugin-board",
	"version": "1.0.0",
	"workbench": { "plugin": { "name": "board", "entry": "./src/plugin.ts" } }
}
```

Der Einstieg exportiert als Default das Ergebnis von `definePlugin()` aus `@workbench/sdk`:

```ts
import { definePlugin } from "@workbench/sdk";

export default definePlugin({
	manifest: {
		name: "board",
		requires: { notes: "^1.2.0" },
		capabilities: [],
	},
	activate: async (ctx) => {},
	deactivate: async () => {},
});
```

- `name` ist der Name, unter dem die Instanz-Config und andere Plugins das Plugin ansprechen: Kleinbuchstaben, Ziffern und Bindestriche, beginnend mit einem Buchstaben, höchstens 56 Zeichen, damit der Name seines Schemas (`plugin_<name>`) in die 63 Zeichen passt, die Postgres für Namen vorsieht. Er muss dem Namen in der `package.json` gleichen. `core` ist vergeben: Unter `core.<name>` bietet der Core eigene Operationen an, und ein Plugin dieses Namens ist ungültig (`invalid_manifest`). Die Version ist die `version` der `package.json`.
- `requires` nennt vorausgesetzte Plugins mit SemVer-Range (`^`, `~`, Vergleichsoperatoren, `x`/`*`, mit Leerzeichen oder `||` kombiniert).
- `capabilities` nennt die Capabilities, die das Plugin braucht. `ctx.capability(name)` liefert nur deklarierte und wirft sonst einen Fehler. Der Core bietet `database` an (`DATABASE_CAPABILITY` aus `@workbench/sdk`) und je Event ein Event-Abo, `event:<plugin>.<Event>` (siehe [Events](#events)); ein Manifest, das eine unbekannte deklariert, ist ungültig.

Beim Start entdeckt der Kernel die Plugin-Pakete, lädt die Einstiege der in `PLUGINS` genannten Plugins, löst ihre `requires` auf und aktiviert sie, vorausgesetzte zuerst. Von einem Plugin, das nicht in `PLUGINS` steht, läuft kein Code, und seine Mängel sind kein Ladefehler. Beim Shutdown (`SIGTERM`, `SIGINT`) stoppt erst der Server, dann endet die Zustellung der [Events](#events): Ein laufender Handler wird abgewartet, höchstens seine Frist, weitere Zustellungen beginnen nicht und bleiben für den nächsten Start liegen. Ebenso endet danach die Job-Queue (siehe [Jobs](#jobs)): Ein laufender Job wird abgewartet, höchstens seine Frist, weitere beginnen nicht. Danach werden die Plugins in umgekehrter Reihenfolge deaktiviert. Änderungen an `PLUGINS` wirken nach einem Neustart.

Jedes Plugin hat für das Laden seines Einstiegs, für `activate` und für `deactivate` je die Frist `PLUGIN_HOOK_TIMEOUT_MS`. Wird der Einstieg nicht rechtzeitig geladen, gilt das Plugin als nicht geladen (`load_timed_out`). Wird `activate` nicht rechtzeitig fertig, gilt das Plugin als nicht geladen (`activation_timed_out`) und der Start geht mit den übrigen weiter. Für ein Plugin, dessen `activate` fehlschlägt oder die Frist überschreitet, ruft der Kernel `deactivate` nicht auf; es muss selbst freigeben, was es bis dahin belegt hat. Wird `deactivate` nicht rechtzeitig fertig oder schlägt es fehl, nennt das Log das Plugin (`plugin deactivation timed out`, `plugin failed to deactivate`), die übrigen werden trotzdem deaktiviert, und die Instanz endet mit Exit-Code 1. Endet die Zustellung der Events nicht sauber, nennt das Log den Fehler im Eintrag `event delivery failed to stop`, und die Instanz endet mit Exit-Code 1; für die Job-Queue heißt der Eintrag `job queue failed to stop`. Lassen sich danach die Datenbankverbindungen nicht schließen, nennt das Log den Fehler im Eintrag `database connections failed to close`, und die Instanz endet ebenfalls mit Exit-Code 1. Ein Signal während des Starts beendet den Start der Plugins: Der Kernel aktiviert kein weiteres Plugin (Log-Eintrag `plugin start stopped` mit den nicht aktivierten in `notActivated`), wartet auf ein gerade laufendes `activate` höchstens die Frist und deaktiviert dann die bereits aktiven Plugins. Lädt der Kernel beim Signal noch Einstiege, lädt er die der übrigen aktivierten Plugins zu Ende, je Plugin höchstens die Frist, und aktiviert danach keines.

Ein Paket, dessen `package.json` nicht lesbar ist oder `workbench.plugin` in anderer Form angibt, überspringt der Kernel; das Log nennt es als Eintrag `plugin package ignored` mit Verzeichnis (`directory`) und Grund (`problem`). Die übrigen Plugin-Pakete sind davon nicht betroffen.

Kann ein Plugin nicht geladen werden, startet die Instanz trotzdem. Das Log nennt jeden Ladefehler als Eintrag `plugin not loaded` mit `plugin`, `reason` und einer ausformulierten Meldung in `detail`; der Eintrag `plugins started` fasst aktive (`active`) und nicht geladene (`notLoaded`) Plugins zusammen. Hat Code des Plugins oder der Core beim Bereitstellen einer Capability einen Fehler geworfen, steht er mit Name, Meldung und Stacktrace in `error`, ebenso im Eintrag `plugin failed to deactivate`. Fehlermeldungen eines Plugins stehen damit im Log und dürfen keine Secrets enthalten.

| `reason`                 | Bedeutung                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `invalid_manifest`       | Manifest, Operationen, Events, Event-Abos, Jobs oder Paketversion ungültig, Einstieg nicht ladbar, Name anders als im Paket. |
| `load_timed_out`         | Der Einstieg des Plugins wurde nicht innerhalb von `PLUGIN_HOOK_TIMEOUT_MS` geladen.                                         |
| `unknown_plugin`         | In `PLUGINS` genannt, aber kein Plugin-Paket stellt das Plugin bereit.                                                       |
| `duplicate_plugin`       | Mehrere Plugin-Pakete deklarieren denselben Plugin-Namen; keines davon wird geladen.                                         |
| `missing_dependency`     | Kein Plugin-Paket stellt ein vorausgesetztes Plugin bereit, oder es ist nicht in `PLUGINS` aktiviert.                        |
| `version_mismatch`       | Die Version eines vorausgesetzten Plugins erfüllt die Range nicht.                                                           |
| `dependency_not_loaded`  | Ein vorausgesetztes Plugin wurde selbst nicht geladen; `detail` nennt dessen Ursache.                                        |
| `dependency_cycle`       | Plugins setzen einander im Kreis voraus; jedes Plugin des Kreises erhält diesen Grund.                                       |
| `capability_unavailable` | Der Core konnte eine deklarierte Capability nicht bereitstellen; `activate` wurde nicht aufgerufen.                          |
| `migration_failed`       | Das Schema des Plugins konnte nicht migriert werden; `detail` nennt die Migration und den Fehler.                            |
| `activation_failed`      | `activate` des Plugins ist fehlgeschlagen.                                                                                   |
| `activation_timed_out`   | `activate` des Plugins wurde nicht innerhalb von `PLUGIN_HOOK_TIMEOUT_MS` fertig.                                            |

### Migrationen

Nur ein Plugin mit der Capability `database` erhält ein eigenes Postgres-Schema, `plugin_<name>` mit `_` statt `-` (für `reference`: `plugin_reference`). `ctx.capability("database")` liefert `{ schema }`. Nach ADR-0003 liest und schreibt ein Plugin nur in diesem Schema.

Seine SQL-Migrationen liegen in einem Verzeichnis des Plugin-Pakets, das die `package.json` unter `workbench.plugin.migrations` nennt:

```json
{
	"workbench": {
		"plugin": {
			"name": "board",
			"entry": "./src/plugin.ts",
			"migrations": "./migrations"
		}
	}
}
```

- Jede Datei mit der Endung `.sql` ist eine Migration. Ihr Name besteht aus vier Ziffern, einem Unterstrich und Kleinbuchstaben, Ziffern oder Unterstrichen, z. B. `0001_create_notes.sql`; die Migrationen laufen in der Reihenfolge ihrer Namen. Andere Dateien bleiben unbeachtet.
- Jede Migration läuft in einer eigenen Transaktion mit dem Schema des Plugins als `search_path`; Tabellen werden daher ohne Schema angelegt.
- Angewandte Migrationen hält die Tabelle `core.migrations` fest (Schema, Dateiname, Zeitpunkt); ein erneuter Start wendet nur neue Migrationen an. Eine angewandte Migration wird nie geändert, sondern durch eine neue ergänzt.
- Die Migrationen des Schemas `core` liegen in `packages/core/migrations` und laufen genauso, mit `core` als `search_path`. Sie legen `core.workspaces` an, die Tabelle der Workspaces (ADR-0002), `core.service_accounts` und `core.api_tokens` für die Service-Accounts und ihre API-Tokens (siehe [HTTP-API](#http-api)) `core.audit_entries` für das [Audit](#audit) sowie `core.events` und `core.event_deliveries`, die Outbox der [Events](#events), `core.jobs`, die Job-Queue der [Jobs](#jobs), und `core.idempotency_keys` für die [Idempotency-Keys](#idempotency-keys). Schlägt eine davon fehl, meldet das Log `instance failed to start` mit `reason` `core_schema_not_migrated`, und die Instanz lädt keine Plugins.
- Jeder Migrationslauf (erst `core`, dann die Schemas der Plugins) hält dieselbe Postgres-Advisory-Lock. Starten zwei Prozesse gleichzeitig, wartet der zweite (Log-Eintrag `migration lock held by another run, waiting`) und wendet nichts doppelt an. Ein Signal beendet das Warten; eine laufende Migration läuft zu Ende, weitere beginnen nicht. Jede Anweisung eines Laufs darf höchstens 60 s dauern, das Warten auf Tabellensperren eingeschlossen; dauert sie länger, schlägt die Migration fehl (`migration failed`) und der Lauf gibt die Lock frei (Begründung in ADR-0008). Lässt sich die Lock danach nicht freigeben, etwa weil die Verbindung während einer Migration abbrach, steht der Eintrag `migration lock not released` mit dem Fehler in `error` im Log; Postgres gibt die Lock mit der beendeten Verbindung ohnehin frei.
- Schlägt eine Migration fehl, wird sie zurückgerollt; die folgenden Migrationen desselben Schemas laufen nicht, die anderer Schemas schon. Das Log nennt Schema, Migration und Fehler (`migration failed`), das Plugin wird nicht geladen (`migration_failed`), und die Instanz meldet nicht „bereit“.
- Nennt die `package.json` Migrationen, deklariert das Manifest aber nicht `database`, ist das Manifest ungültig.

### Operationen

Ein Plugin deklariert seine Operationen in `definePlugin({ manifest, operations })`, jede mit `defineOperation()` aus `@workbench/sdk`:

```ts
const renameLabel = defineOperation({
	name: "renameLabel",
	kind: "mutation",
	target: "workspace",
	right: "board.label.edit",
	input: z.object({ label: z.string().min(1) }),
	output: z.object({ label: z.string() }),
	execute: async (input, ctx) => ({ label: input.label }),
});
```

- `name` ist Verb und Objekt in camelCase (`createLabel`). Die Registry vergibt den Namen `<plugin>.<name>`, hier `board.renameLabel`.
- `kind` ist `query` (nur lesen) oder `mutation`, `target` ist `object` oder `workspace`. Bisher wird `target` nur beim Laden geprüft; die Pipeline ruft jede Operation auf einem Workspace auf. Operationen auf einem einzelnen Objekt (`object`) folgen in einem späteren Ticket.
- `right` nennt genau ein Recht des eigenen Plugins: `<plugin>.` gefolgt von Abschnitten aus Kleinbuchstaben, Ziffern und Bindestrichen, durch Punkte getrennt (`board.label.edit`). Das Recht wird bisher nur beim Laden geprüft, aber beim Aufruf nicht durchgesetzt: Jeder Akteur darf jede Operation aufrufen. Die Prüfung folgt in einem späteren Ticket mit Identität und Zugriff.
- `input` und `output` sind Schemas nach [Standard Schema](https://standardschema.dev), etwa von zod 4 (ADR-0010).

Eine Operation mit unbekannter Art oder unbekanntem Ziel, ohne Recht oder mit mehreren, mit dem Recht eines anderen Plugins, ohne Schema, ohne `execute` oder mit einem Namen, den das Plugin schon deklariert, macht das Plugin ungültig: Es wird nicht geladen (`invalid_manifest`), und `detail` nennt jede fehlerhafte Operation.

### Aufruf einer Operation

Ein Akteur ruft eine Operation mit ihrem Namen, einem Workspace und einer Eingabe auf. Die Pipeline des Cores

1. sucht die Operation unter den Operationen des Cores (`core.<name>`) und der aktiven Plugins,
2. prüft die Eingabe gegen das Eingabe-Schema,
3. öffnet eine Transaktion, für eine `query` nur lesend, mit dem Schema des Plugins als `search_path` (für eine Operation des Cores `core`),
4. prüft, dass der Workspace in `core.workspaces` existiert,
5. führt `execute(input, ctx)` aus; `ctx` nennt `actor`, `workspace`, `sql` (eine Funktion des Cores, die eine Anweisung als Tagged Template sofort in der Transaktion ausführt; weitere Methoden des Datenbank-Clients hat sie nicht, wie in Event-Handlern und Jobs), `now()`, `newId()`, `random()`, `publish()` (siehe [Events](#events)) und `enqueue()` (siehe [Jobs](#jobs)),
6. bildet den Rückgabewert über das Ausgabe-Schema ab,
7. schreibt für eine `mutation` einen Audit-Eintrag in dieselbe Transaktion (siehe [Audit](#audit)) und schreibt die Transaktion fest.

Wirft `execute`, passt die Ausgabe nicht zum Schema oder lässt sich der Audit-Eintrag nicht schreiben, wird die Transaktion zurückgerollt, samt der Events, die die Mutation publiziert, und der Jobs, die sie eingereiht hat. Ein fachlicher Fehler ist ein `OperationError` aus `@workbench/sdk` mit Art (`not_found`, `conflict`, `rejected`), Code (Kleinbuchstaben, Ziffern, Unterstriche) und einer Meldung für den Aufrufer; der Aufrufer erhält den Code als `<plugin>.<code>`, von einer Operation des Cores als `core.<code>`. Jeder andere Fehler erreicht den Aufrufer nur als `internal_error`.

| Code                      | Art             | Bedeutung                                                                                                                                           |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_input`           | `invalid_input` | Die Eingabe passt nicht zum Eingabe-Schema; `issues` nennt je Befund Pfad und Meldung.                                                              |
| `invalid_idempotency_key` | `invalid_input` | Der Idempotency-Key hat nicht 1 bis 255 sichtbare ASCII-Zeichen oder Leerzeichen ohne Komma.                                                        |
| `idempotency_key_reused`  | `rejected`      | Der Idempotency-Key wurde schon für eine andere Operation, einen anderen Workspace oder eine andere Eingabe verwendet.                              |
| `unknown_operation`       | `not_found`     | Weder der Core noch ein aktives Plugin hat eine Operation dieses Namens.                                                                            |
| `workspace_not_found`     | `not_found`     | Der Workspace existiert nicht.                                                                                                                      |
| `internal_error`          | `internal`      | `execute` warf einen anderen Fehler als `OperationError`, die Ausgabe passt nicht zum Schema, oder die Pipeline scheiterte außerhalb von `execute`. |
| `<plugin>.<code>`         | aus dem Fehler  | `execute` warf einen `OperationError`.                                                                                                              |

Ein `internal_error` steht mit `correlationId`, `operation` und `reason` im Log als Eintrag `operation failed`: `execute_threw`, wenn `execute` warf, mit dem Fehler in `error`; `invalid_output` mit den Befunden des Ausgabe-Schemas in `issues`; oder `pipeline_failed`, wenn die Pipeline außerhalb von `execute` scheiterte (etwa ein Schema, das wirft oder ein Ergebnis liefert, das nicht Standard Schema entspricht, ein unerreichbares Postgres beim Öffnen der Transaktion oder beim Prüfen des Workspace, ein Audit-Eintrag, der sich nicht schreiben lässt, ein gescheitertes Festschreiben), mit dem Fehler in `error`.

Jedes Scheitern lässt sich als Problem Details nach RFC 9457 abbilden (`toProblemDetails` in `packages/core/src/problem-details.ts`), mit `type` `urn:workbench:problem:<code>`, `title` und `status` nach der Art (`invalid_input` 400, `not_found` 404, `conflict` 409, `rejected` 422, `internal` 500), `detail`, `code`, `correlationId` und `issues`:

```json
{
	"type": "urn:workbench:problem:invalid_input",
	"title": "Bad Request",
	"status": 400,
	"detail": "the input does not match the input schema of the operation",
	"code": "invalid_input",
	"correlationId": "request-7",
	"issues": [{ "path": ["title"], "message": "Too small" }]
}
```

Die Pipeline prüft bisher keine Rechte; das folgt mit Identität und Zugriff.

#### Idempotency-Keys

Ein Akteur kann einer Mutation einen Idempotency-Key mitgeben, damit eine Wiederholung, etwa nach einer Zeitüberschreitung, keinen zweiten Effekt hat (ADR-0017). Der Key ist 1 bis 255 sichtbare ASCII-Zeichen oder Leerzeichen ohne Komma lang, sonst scheitert die Mutation mit `invalid_idempotency_key`, bevor irgendetwas läuft.

- Der erste Aufruf mit einem Key führt die Mutation aus und hält ihre Antwort in `core.idempotency_keys` fest, in ihrer Transaktion. Jeder weitere Aufruf desselben Akteurs mit demselben Key, derselben Operation, demselben Workspace und derselben Eingabe erhält dieselbe Antwort, ohne dass `execute` läuft, und hinterlässt keinen Audit-Eintrag, kein Event und keinen Job. Die Eingabe gilt als dieselbe, wenn ihr JSON dieselben Felder mit denselben Werten hat, in beliebiger Reihenfolge.
- Nennt ein weiterer Aufruf mit demselben Key eine andere Operation, einen anderen Workspace oder eine andere Eingabe, scheitert er mit `idempotency_key_reused`, und die Mutation läuft nicht.
- Kommt ein zweiter Aufruf mit demselben Key, während der erste noch läuft, wartet er auf ihn und antwortet wie er; scheitert der erste, führt der zweite die Mutation aus.
- Keys sind je Akteur getrennt: Derselbe Key zweier Akteure, auch eines Nutzers und eines Service-Accounts mit derselben ID, sind zwei Keys.
- Scheitert die Mutation, bleibt der Key frei: Ein weiterer Aufruf mit ihm führt sie erneut aus.
- Eine Query beachtet den Key nicht, auch nicht seine Form, und läuft bei jedem Aufruf.
- Ein Key gilt mindestens 24 Stunden ab seinem ersten Aufruf. Danach löscht ihn der Cron-Job des Cores `core.removeExpiredIdempotencyKeys`, der alle zehn Minuten (`*/10 * * * *`) läuft und je Lauf höchstens 10 000 abgelaufene Keys löscht; mit ihm verschwindet die festgehaltene Antwort. Bis er gelöscht ist, gilt ein abgelaufener Key weiter, danach führt ein Aufruf mit ihm die Mutation wieder aus.

### Audit

Jede Mutation, die gelingt, hinterlässt genau einen Audit-Eintrag in `core.audit_entries`, ohne Zutun des Plugins (ADR-0014). Die Pipeline schreibt ihn in der Transaktion der Mutation: Wird sie zurückgerollt, gibt es keinen Eintrag, und lässt sich der Eintrag nicht schreiben, gibt es keine Mutation. Eine Query hinterlässt keinen Eintrag, eine gescheiterte Mutation steht nur im Log (`operation failed`).

Die Query `core.listAuditEntries` liefert die Einträge des Workspaces im Pfad, die neuesten zuerst, seitenweise. Die Eingabe nennt `limit` (1 bis 100) und `cursor`: `null` für die erste Seite, danach `nextCursor` der Seite davor.

```json
{
	"entries": [
		{
			"id": "0b9f…",
			"occurredAt": "2026-11-27T08:30:00.000Z",
			"actor": { "kind": "service_account", "id": "7d4b…" },
			"apiTokenId": "51c2…",
			"operation": "reference.createNote",
			"workspace": "3fa8…",
			"result": "succeeded"
		}
	],
	"nextCursor": "WyIyMDI2…"
}
```

- `actor` nennt Art (`user`, `service_account`) und ID des Akteurs, `apiTokenId` die ID des API-Tokens, mit dem der Aufruf kam, oder `null` für einen Aufruf ohne Token (etwa über das Test-Harness). So lässt sich unterscheiden, ob ein Mensch oder ein Agent gehandelt hat. Ein Eintrag enthält nie ein Token, seinen Hash oder die Eingabe der Mutation.
- `occurredAt` ist der Zeitpunkt in UTC, auf Millisekunden genau, `workspace` das Ziel der Mutation, `result` bisher immer `succeeded`.
- `nextCursor` ist `null`, wenn keine älteren Einträge folgen. Ein Cursor ist undurchsichtig und gilt nur als Ganzes, Zeichen für Zeichen so, wie eine Seite ihn nennt; einen, der keine Position im Audit nennt, lehnt die Operation mit `core.invalid_cursor` ab (Art `rejected`, per HTTP 422). Einträge desselben Zeitpunkts ordnet ihre ID, sodass keine Seite einen Eintrag wiederholt oder auslässt, auch wenn inzwischen neue entstehen.
- Die Operation verweist auf das Recht `core.audit.read`, das für den Instanz-Admin gedacht ist. Solange Rechte nicht durchgesetzt werden (siehe [Operationen](#operationen)), darf jeder Akteur mit gültigem Token das Audit jedes Workspaces lesen.

### Events

Ein Plugin publiziert Events und abonniert die Events anderer Plugins. Ein Event ist ein Fakt in Vergangenheitsform. Seine Definition liegt im [Contract](#contract) des publizierenden Plugins, mit `defineEvent()` aus `@workbench/sdk`:

```ts
export const labelRenamed = defineEvent({
	plugin: "board",
	name: "LabelRenamed",
	version: 1,
	payload: z.object({ labelId: z.string() }),
});
```

- `plugin` ist der Name des publizierenden Plugins, `name` der Fakt in PascalCase. Geprüft wird beim Laden nur PascalCase; die Vergangenheitsform ist Konvention. Das Event heißt `<plugin>.<name>`, hier `board.LabelRenamed`.
- `version` ist eine ganze Zahl ab 1, `payload` ein Schema nach Standard Schema (ADR-0010). Die Payload nennt IDs, keine Objekte: Wer mehr braucht, fragt das publizierende Plugin.

Das publizierende Plugin nennt seine Events in `definePlugin({ manifest, events })`. Ein abonnierendes Plugin importiert die Definition aus dem Contract, deklariert für jedes Event die Capability `event:<plugin>.<name>` (`eventSubscriptionCapability(labelRenamed)`) und registriert seinen Event-Handler ausdrücklich in `subscriptions`:

```ts
import { labelRenamed } from "@workbench/plugin-board/contract";

export default definePlugin({
	manifest: {
		name: "search",
		capabilities: [eventSubscriptionCapability(labelRenamed)],
	},
	subscriptions: [
		defineEventSubscription({
			event: labelRenamed,
			handle: async (event, ctx) => {},
		}),
	],
});
```

Ein Abo setzt kein `requires` voraus: Ist das publizierende Plugin nicht aktiv, kommt das Event nie. Das ist kein Ladefehler, denn das publizierende Plugin kann schlicht nicht in `PLUGINS` stehen; abonniert ein aktives Plugin aber ein Event, das kein aktives Plugin in `events` deklariert, etwa wegen eines Tippfehlers im Namen, steht das beim Start je Abo als Warnung `subscribed event not declared` mit `subscriber` und `event` im Log. `ctx.capability("event:board.LabelRenamed")` liefert `{ event: "board.LabelRenamed" }`.

Ein Plugin wird nicht geladen (`invalid_manifest`, `detail` nennt jeden Mangel), wenn

- es ein Event abonniert, ohne die Capability dieses Events zu deklarieren,
- es ein Event unter dem Namen eines anderen Plugins deklariert, mit einem Namen, der nicht PascalCase ist, ohne Version ab 1, ohne Payload-Schema oder mehrfach,
- ein Abo keine Event-Definition, eine mit ungültigem Plugin-Namen oder Event-Namen oder keinen Handler nennt oder dasselbe Event mehrfach abonniert.

#### Publizieren

Eine Mutation publiziert ein Event in `execute`:

```ts
await ctx.publish(labelRenamed, { labelId: input.labelId });
```

Der Core prüft die Payload gegen das Schema der Definition und schreibt das Event in die Outbox `core.events`, in der Transaktion der Mutation (ADR-0015): ID, Name, Version, Zeitpunkt in UTC, Workspace und Payload, dazu in `core.event_deliveries` je eine Zustellung für jedes in `PLUGINS` aktivierte Plugin, dessen gültige Definition das Event abonniert, auch wenn es gerade einen Ladefehler hat. Die Payload ist, was das Schema aus dem übergebenen Wert macht; zod-Objekte lassen unbekannte Felder weg. Gespeichert wird ihre JSON-Form, und weil der Handler später genau diese zu lesen bekommt, prüft der Core sie beim Publizieren noch einmal gegen das Schema. Was das Schema aus der gespeicherten Form macht, muss wieder dieselbe JSON-Form haben: `z.coerce.date()`, ein Standardwert oder weggelassene Felder erfüllen das, eine Umformung wie `.transform((n) => n * 2)`, die bei jedem Lesen weiterrechnet, nicht. Tiefer als 100 Ebenen aus Listen und Objekten darf eine Payload nicht verschachtelt sein. Wird die Mutation zurückgerollt, gibt es das Event nicht, und kein Handler erfährt je davon.

`publish` wirft, und die Mutation scheitert mit `internal_error` (`execute_threw` im Log, mit dem Fehler in `error`), wenn

- das Plugin das Event nicht selbst in `events` deklariert, etwa das Event eines anderen Plugins (`UndeclaredEventError`),
- die Payload nicht zum Schema passt (`InvalidEventPayloadError`, mit den Befunden in `issues`); ebenso, wenn das Schema ihre gespeicherte JSON-Form nicht wieder annimmt, etwa `z.date()`, dessen Datum in JSON ein String ist (`z.coerce.date()` nimmt ihn an), wenn es sie beim erneuten Lesen verändert, ist sie tiefer als 100 Ebenen verschachtelt oder hat sie keine JSON-Form, die Postgres speichert (`undefined`, eine Funktion, ein BigInt, ein Wert, der sich selbst enthält, ein String mit NUL-Zeichen oder halbem Surrogatpaar),
- eine Query publiziert (`EventPublishedByQueryError`).

#### Zustellen

Ein Event wird erst nach dem Festschreiben seiner Mutation zugestellt, jedem abonnierenden Plugin für sich und mindestens einmal. Der Handler erhält das Event und einen Kontext:

- `event` nennt `id`, `name` (`board.LabelRenamed`), `version`, `occurredAt`, `workspace` und `payload`, geprüft gegen das Schema der Definition, die das abonnierende Plugin importiert hat.
- `ctx` nennt `sql`, `now()`, `newId()` und `random()`. `sql` ist eine Transaktion mit dem Schema des abonnierenden Plugins als `search_path`. Einen Akteur hat ein Handler bisher nicht; der Plugin-Service-Account folgt mit Identität und Zugriff.

Der Core vermerkt die Zustellung in der Transaktion des Handlers. Was der Handler über `ctx.sql` schreibt, gibt es deshalb nur zusammen mit der gelungenen Zustellung. Wirft der Handler, wird er nicht innerhalb von `PLUGIN_HOOK_TIMEOUT_MS` fertig, lehnt das Schema die Payload ab oder lässt sich die Transaktion nicht festschreiben, wird zurückgerollt, was er geschrieben hat, und der Core stellt später erneut zu, mit derselben `id`. Die Frist beginnt vor der Prüfung der Payload: Ein Schema, dessen Prüfung nicht fertig wird, scheitert wie ein Handler, der nicht fertig wird, und endet die Prüfung erst nach Ablauf der Frist, ruft der Core den Handler nicht mehr auf. Die Wartezeit wächst mit jedem Versuch exponentiell mit Zufallsanteil (bis 1 s nach dem ersten, höchstens 5 min). Nach 25 gescheiterten Versuchen gibt der Core die Zustellung auf und legt sie in den Dead-Letter; das sind im Mittel rund 40 min, höchstens rund 1,4 h nach dem ersten Versuch. Ein Durchgang, der als Ganzes scheitert, weil Postgres nicht antwortet, zählt keinen Versuch.

Läuft die Frist ab, während eine Anweisung des Handlers in Postgres läuft, bricht der Core sie über eine zweite Verbindung ab (`pg_cancel_backend`), die er nur dafür hält, mit derselben `DATABASE_URL` aufbaut und nach 30 s ohne Abbruch wieder schließt, rollt zurück und vermerkt die gescheiterte Zustellung sofort, statt auf das Ende der Anweisung zu warten. Steht danach noch die Antwort auf eine Anweisung aus, die der Handler vor Ablauf der Frist begonnen hat, etwa weil sie Postgres erst nach dem Abbruch erreichte, bricht der Core alle 100 ms erneut ab, bis keine mehr offen ist. Der Handler selbst läuft im Prozess weiter: Jede Anweisung, die er nach Ablauf der Frist über `ctx.sql` beginnt, lehnt der Core mit einem `StatementRefusedError` ab, ohne sie an Postgres zu senden, sodass sie das Zurückrollen nicht aufhält. Dafür nimmt `ctx.sql` im Handler Anweisungen nur als Tagged Template an und führt jede sofort aus; weitere Methoden des Datenbank-Clients hat es nicht. Code außerhalb von SQL, etwa der Aufruf eines Fremdsystems, lässt sich nicht abbrechen. Lässt sich die Anweisung nicht abbrechen, etwa weil Postgres binnen 5 s keine weitere Verbindung annimmt, steht der Eintrag `statement not cancelled` mit `eventId`, `event`, `subscriber` und dem Fehler in `error` im Log. Die Zustellung scheitert dann weiter mit `handler_timed_out`, aber erst, wenn die Anweisung endet: Für die Anweisungen des Handlers setzt der Core das `statement_timeout` auf `PLUGIN_HOOK_TIMEOUT_MS` plus 1 s, höchstens auf die 60 s der Verbindung, sodass Postgres jede von ihnen spätestens so lange nach ihrem Beginn abbricht. Für den Vermerk der Zustellung gelten danach wieder die 60 s.

Ein Handler ist deshalb idempotent: Eine Wirkung außerhalb der eigenen Datenbank, etwa eine Mail, kann sich wiederholen, wenn der Handler nach ihr scheitert. Die `id` des Events ist der Schlüssel, an dem er eine Wiederholung erkennt.

Eine gelungene Zustellung steht nur mit `LOG_LEVEL=debug` im Log, als Eintrag `event delivered` mit `eventId`, `event` (dem Namen, etwa `board.LabelRenamed`) und `subscriber`. Jede gescheiterte Zustellung steht im Log als Eintrag `event not delivered` mit `eventId`, `event`, `subscriber`, `attempt`, `retryInMs` und `reason`; der 25. Versuch als Eintrag `event dead-lettered`, ohne `retryInMs`:

| `reason`            | Bedeutung                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handler_threw`     | Der Handler hat einen Fehler geworfen; er steht mit Name, Meldung und Stacktrace in `error`.                                                                                  |
| `handler_timed_out` | Die Prüfung der Payload und der Handler wurden zusammen nicht innerhalb von `timeoutMs` (`PLUGIN_HOOK_TIMEOUT_MS`) fertig.                                                    |
| `invalid_payload`   | Die Payload passt nicht zum Schema des abonnierenden Plugins; `issues` nennt die Befunde.                                                                                     |
| `delivery_failed`   | Die Zustellung scheiterte außerhalb des Handlers, etwa beim Festschreiben (ein aufgeschobener Constraint) oder weil das Schema der Payload warf; der Fehler steht in `error`. |

- Die Reihenfolge ist nicht zugesichert: Ein Event, dessen Zustellung scheitert, hält die folgenden nicht auf, gleich aus welchem Grund sie scheitert.
- Ein Plugin, das beim Publizieren in `PLUGINS` steht, aber nicht aktiv ist, etwa weil `activate` oder seine Migration scheiterte oder ein vorausgesetztes Plugin fehlt, erhält das Event, sobald es nach einem Neustart aktiv ist. Ausgenommen ist ein Plugin, dessen Definition selbst ungültig ist oder nicht geladen werden konnte (`invalid_manifest`, `load_timed_out`, `unknown_plugin`, `duplicate_plugin`): Für es entsteht keine Zustellung, und es erhält die Events aus dieser Zeit nie.
- Die Version eines Events wird nicht mit der Version verglichen, die das abonnierende Plugin importiert hat. Passt die Payload einer anderen Version nicht zu dessen Schema, scheitert die Zustellung bei jedem Versuch mit `invalid_payload`, bis sie nach dem 25. im Dead-Letter landet.
- Eine Zustellung an ein Plugin, das gerade nicht aktiv ist, bleibt liegen, bis es wieder aktiv ist, höchstens bis zur Zustellfrist von 30 Tagen nach `occurred_at` des Events. Ein Plugin, das ein Event erst später abonniert oder erst später in `PLUGINS` aufgenommen wird, erhält die Events von davor nicht.
- Ein Handler publiziert bisher selbst keine Events.

Die Instanz stellt zu, sobald eine Mutation mit Events festgeschrieben ist, und sieht zusätzlich jede Sekunde nach fälligen Zustellungen: nach Wiederholungen und nach Events, die ein Absturz oder ein anderer Prozess liegen ließ. Sie versucht eine Zustellung nach der anderen. Scheitert ein solcher Durchgang als Ganzes, etwa weil Postgres nicht antwortet, nennt das Log den Fehler im Eintrag `event delivery failed`, und der nächste Durchgang folgt nach einer Sekunde.

Ist eine Zustellung 30 Tage nach `occurred_at` ihres Events noch offen, ist ihre Zustellfrist abgelaufen: Der Core versucht sie nicht mehr und legt sie mit dem Grund `delivery_expired` in den Dead-Letter, auch wenn das abonnierende Plugin nicht aktiv ist oder gar nicht mehr in `PLUGINS` steht. Er sieht danach mit der Aufbewahrung (unten) einmal je Stunde, höchstens 1000 Zustellungen auf einmal; eine abgelaufene Zustellung kann deshalb bis zu einer Stunde offen stehen, bevor sie im Dead-Letter liegt, wird aber nicht mehr versucht. Je abonnierendem Plugin steht dann der Eintrag `event deliveries expired` auf Level `error` mit `subscriber`, `reason` (`delivery_expired`) und der Zahl `expired` der Zustellungen im Log.

`core.event_deliveries` zeigt den Stand jeder Zustellung: `attempts`, `next_attempt_at`, `delivered_at` für eine gelungene und `dead_lettered_at` mit `failure_reason` für eine aufgegebene, der Grund des letzten Versuchs oder `delivery_expired`. Der Dead-Letter der Events sind die Zeilen mit `dead_lettered_at`. Ein Betreiber stellt eine solche Zustellung nach behobener Ursache von Hand erneut zu, solange ihr Event nicht gelöscht und ihre Zustellfrist nicht abgelaufen ist; sonst landet sie beim nächsten Nachsehen wieder im Dead-Letter:

```sql
UPDATE core.event_deliveries
SET dead_lettered_at = NULL, failure_reason = NULL, attempts = 0, next_attempt_at = now()
WHERE event_id = '…' AND subscriber = '…';
```

Abgeschlossene Events bleiben nicht für immer in der Outbox: Der Core löscht ein Event samt seinen Zustellungen aus `core.events` und `core.event_deliveries`, sobald jede seiner Zustellungen gelungen oder im Dead-Letter ist und die jüngste davon (`delivered_at` oder `dead_lettered_at`) 7 Tage zurückliegt; ein Event, das beim Publizieren kein Plugin abonnierte, löscht er 7 Tage nach `occurred_at`. Erneut zustellen lässt sich eine Zustellung im Dead-Letter also nur innerhalb dieser 7 Tage. Ein Event mit einer offenen Zustellung wird nicht gelöscht, und seine abgeschlossenen Zustellungen bleiben mit ihm stehen; spätestens nach Zustellfrist und Aufbewahrung, 37 Tage nach `occurred_at`, ist es fort. Die Fristen sind fest und rechnen mit der Uhr der Instanz. Jeder Prozess sieht dafür einmal je Stunde am Ende eines Durchgangs nach und löscht höchstens 1000 Events auf einmal; waren es 1000, macht er im nächsten Durchgang weiter, bis nichts mehr übrig ist. Hat er etwas gelöscht, steht mit `LOG_LEVEL=debug` der Eintrag `settled events removed` mit der Zahl `removed` der Events im Log. Das gilt auch in einer Instanz, in der kein aktives Plugin ein Event abonniert; gelöscht wird, sobald das Core-Schema migriert ist.

### Jobs

Ein Job ist Hintergrundarbeit eines Plugins, die eine Mutation einreiht und die Instanz nach dem Festschreiben ausführt, außerhalb der Anfrage und mindestens einmal (ADR-0016). Ein Plugin definiert ihn mit `defineJob()` aus `@workbench/sdk` und nennt ihn in `definePlugin({ manifest, jobs })`:

```ts
export const sendReminder = defineJob({
	name: "sendReminder",
	payload: z.object({ cardId: z.string() }),
	maxAttempts: 5,
	run: async (job, ctx) => {},
});
```

- `name` ist in camelCase; der Job heißt `<plugin>.<name>`, hier `board.sendReminder`.
- `payload` ist ein Schema wie bei einer Operation.
- `maxAttempts` ist die Zahl der Versuche, nach der der Job im Dead-Letter landet, 1 bis 25.

Ein Plugin ist ungültig (`invalid_manifest`), wenn ein Job keinen Namen in camelCase, kein Payload-Schema, kein `maxAttempts` von 1 bis 25 oder keine Funktion `run` hat oder mehrfach deklariert ist; für einen [Cron-Job](#cron-jobs) gilt dasselbe, mit dem Zeitplan an der Stelle des Payload-Schemas.

#### Einreihen

Eine Mutation reiht einen Job in `execute` ein:

```ts
await ctx.enqueue(sendReminder, { cardId });
```

Der Core prüft die Payload gegen das Schema der Definition und schreibt den Job in die Job-Queue `core.jobs`, in der Transaktion der Mutation: ID, Name, Payload, Workspace und Zeitpunkt in UTC. Die Payload ist, was das Schema aus dem übergebenen Wert macht. Gespeichert wird ihre JSON-Form, und weil `run` später genau diese zu lesen bekommt, prüft der Core sie beim Einreihen noch einmal gegen das Schema. Was das Schema aus der gespeicherten Form macht, muss wieder dieselbe JSON-Form haben: `z.coerce.date()`, ein Standardwert oder weggelassene Felder erfüllen das, eine Umformung wie `.transform((n) => n * 2)`, die bei jedem Lesen weiterrechnet, nicht. Tiefer als 100 Ebenen aus Listen und Objekten darf eine Payload nicht verschachtelt sein. Wird die Mutation zurückgerollt, gibt es den Job nicht, und er läuft nie.

`enqueue` wirft, und die Operation scheitert mit `internal_error` (Log-Eintrag `operation failed`, `reason` `execute_threw`), wenn

- das Plugin den Job nicht selbst in `jobs` deklariert (`UndeclaredJobError`),
- die Payload nicht zum Schema passt (`InvalidJobPayloadError`, mit den Befunden in `issues`); ebenso, wenn das Schema ihre gespeicherte JSON-Form nicht wieder annimmt, etwa `z.date()`, dessen Datum in JSON ein String ist (`z.coerce.date()` nimmt ihn an), wenn es sie beim erneuten Lesen verändert, ist sie tiefer als 100 Ebenen verschachtelt oder hat sie keine JSON-Form, die Postgres speichert (`undefined`, eine Funktion, ein BigInt, ein Wert, der sich selbst enthält, ein String mit NUL-Zeichen oder halbem Surrogatpaar),
- eine Query einreiht (`JobEnqueuedByQueryError`).

#### Ausführen

Ein Job läuft erst nach dem Festschreiben seiner Mutation. `run` erhält den Job und einen Kontext:

- `job` nennt `id`, `name` (`board.sendReminder`), `attempt` (ab 1), `enqueuedAt`, `workspace` und `payload`, erneut geprüft gegen das Schema der Definition.
- `ctx` nennt `sql`, eine Transaktion mit dem Schema des Plugins als `search_path`, `now()`, `newId()` und `random()`.

Der Core vermerkt den erledigten Job in der Transaktion von `run`. Was `run` über `ctx.sql` schreibt, gibt es deshalb nur zusammen mit dem erledigten Job. Ein Versuch scheitert, wenn `run` wirft, nicht innerhalb von `PLUGIN_HOOK_TIMEOUT_MS` fertig wird oder sich die Transaktion nicht festschreiben lässt; die Frist beginnt vor der Prüfung der Payload, sodass auch ein Schema, dessen Prüfung nicht fertig wird, den Versuch scheitern lässt, und endet die Prüfung erst nach Ablauf der Frist, ruft der Core `run` nicht mehr auf; dann wird zurückgerollt, was er geschrieben hat. Der Core wiederholt den Job mit derselben `id` nach einer Wartezeit, die mit jedem Versuch exponentiell wächst und einen Zufallsanteil hat (Full Jitter: bis 5 s nach dem ersten, bis 10 s nach dem zweiten, höchstens 1 h). Scheitert der letzte Versuch (`maxAttempts`), landet der Job im Dead-Letter und läuft nicht mehr.

Läuft die Frist ab, während eine Anweisung von `run` in Postgres läuft, bricht der Core sie über eine zweite Verbindung ab (`pg_cancel_backend`), die er nur dafür hält, mit derselben `DATABASE_URL` aufbaut und nach 30 s ohne Abbruch wieder schließt, rollt zurück und vermerkt den gescheiterten Versuch sofort, statt auf das Ende der Anweisung zu warten. Steht danach noch die Antwort auf eine Anweisung aus, die `run` vor Ablauf der Frist begonnen hat, etwa weil sie Postgres erst nach dem Abbruch erreichte, bricht der Core alle 100 ms erneut ab, bis keine mehr offen ist. `run` selbst läuft im Prozess weiter: Jede Anweisung, die es nach Ablauf der Frist über `ctx.sql` beginnt, lehnt der Core mit einem `StatementRefusedError` ab, ohne sie an Postgres zu senden, sodass sie das Zurückrollen nicht aufhält. Dafür nimmt `ctx.sql` in `run` Anweisungen nur als Tagged Template an und führt jede sofort aus; weitere Methoden des Datenbank-Clients hat es nicht. Code außerhalb von SQL, etwa der Aufruf eines Fremdsystems, lässt sich nicht abbrechen und kann sich mit der Wiederholung überschneiden. Lässt sich die Anweisung nicht abbrechen, etwa weil Postgres binnen 5 s keine weitere Verbindung annimmt, steht der Eintrag `statement not cancelled` mit `jobId`, `job`, `attempt` und dem Fehler in `error` im Log. Der Versuch scheitert dann weiter mit `run_timed_out`, aber erst, wenn die Anweisung endet: Für die Anweisungen von `run` setzt der Core das `statement_timeout` auf `PLUGIN_HOOK_TIMEOUT_MS` plus 1 s, höchstens auf die 60 s der Verbindung, sodass Postgres jede von ihnen spätestens so lange nach ihrem Beginn abbricht. Für den Vermerk des erledigten Jobs gelten danach wieder die 60 s.

Ein Job ist deshalb idempotent: Eine Wirkung außerhalb der eigenen Datenbank, etwa eine Mail, kann sich wiederholen, wenn der Job nach ihr scheitert. Die `id` des Jobs ist der Schlüssel, an dem er eine Wiederholung erkennt.

Ein erledigter Job steht nur mit `LOG_LEVEL=debug` im Log, als Eintrag `job completed` mit `jobId`, `job` (dem Namen) und `attempt`. Jeder gescheiterte Versuch steht im Log als Eintrag `job failed` mit `jobId`, `job`, `attempt`, `retryInMs` und `reason`; der letzte als Eintrag `job dead-lettered`, ohne `retryInMs`:

| `reason`          | Bedeutung                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run_threw`       | `run` hat geworfen; der Fehler steht in `error`.                                                                                                                                           |
| `run_timed_out`   | Die Prüfung der Payload und `run` wurden zusammen nicht innerhalb von `timeoutMs` fertig.                                                                                                  |
| `invalid_payload` | Das Schema der Definition lehnt die gespeicherte Payload ab, etwa nach einer Änderung des Schemas; `issues` nennt die Mängel. Der Job landet sofort im Dead-Letter, ohne Wiederholung.     |
| `attempt_failed`  | Der Versuch scheiterte außerhalb von `run`, etwa beim Festschreiben (ein aufgeschobener Constraint) oder weil das Schema der Payload warf; der Fehler steht in `error`.                    |
| `attempt_lost`    | Der letzte Versuch gelang weder noch scheiterte er vor Ablauf der Wiederzustellungsfrist, etwa weil der Prozess mitten darin endete. Der Job landet im Dead-Letter, ohne weiteren Versuch. |

Die Job-Queue `core.jobs` zeigt den Stand jedes Jobs: `state` ist `pending`, `completed` oder `dead`, dazu `attempts`, `next_attempt_at`, `settled_at` und `failure_reason`, der Grund des letzten gescheiterten Versuchs. Der Dead-Letter sind die Zeilen mit `state = 'dead'`. Ein Betreiber reiht einen solchen Job nach behobener Ursache von Hand wieder ein:

```sql
UPDATE core.jobs SET state = 'pending', settled_at = NULL, attempts = 0, next_attempt_at = now() WHERE id = '…';
```

Abgeschlossene Jobs bleiben nicht für immer in `core.jobs`: Der Core löscht einen erledigten Job (`completed`) 7 Tage und einen Job im Dead-Letter (`dead`) 30 Tage nach `settled_at`. Von Hand wieder einreihen lässt sich ein Job im Dead-Letter also nur innerhalb dieser 30 Tage; danach ist er samt Payload fort. Ein offener Job (`pending`) wird nie gelöscht, wie lange er auch liegt, und je Cron-Job bleibt die Zeile mit der jüngsten Fälligkeit stehen, weil der Core an sie anschließt. Die Fristen sind fest und rechnen mit der Uhr der Instanz. Jeder Prozess sieht dafür einmal je Stunde am Ende eines Durchgangs nach und löscht höchstens 1000 Zeilen auf einmal; waren es 1000, macht er im nächsten Durchgang weiter, bis nichts mehr übrig ist. Hat er etwas gelöscht, steht mit `LOG_LEVEL=debug` der Eintrag `settled jobs removed` mit der Zahl `removed` im Log. Gelöscht wird auch in einer Instanz, in der kein aktives Plugin einen Job deklariert, sobald das Core-Schema migriert ist. Außerdem steht dort immer der Cron-Job des Cores `core.removeExpiredIdempotencyKeys` (siehe [Idempotency-Keys](#idempotency-keys)); Namen `core.<name>` gehören dem Core.

- Beginnt ein Versuch, zählt der Core ihn sofort und stellt den Job für die Wiederzustellungsfrist zurück: die Frist eines Versuchs (`PLUGIN_HOOK_TIMEOUT_MS`) plus 60 s. Endet der Prozess mitten im Versuch, läuft der Job nach dieser Frist erneut, auch in einem anderen Prozess; der abgebrochene Versuch zählt mit, und war es der letzte, landet der Job mit `attempt_lost` im Dead-Letter. Weil die Frist länger ist als die eines Versuchs, laufen nie zwei Versuche desselben Jobs zugleich, solange `run` seine Frist einhält.
- Die Reihenfolge ist nicht zugesichert: Ein Job, der scheitert, hält die übrigen nicht auf.
- Ein Job eines Plugins, das gerade nicht aktiv ist, bleibt liegen, bis es wieder aktiv ist, ohne Frist.
- Ein Job hat bisher keinen Akteur, publiziert keine Events und reiht selbst keine Jobs ein; das gilt auch für einen Cron-Job.

Die Instanz führt Jobs aus, sobald eine Mutation mit Jobs festgeschrieben ist, und sieht zusätzlich jede Sekunde nach fälligen Jobs: nach Wiederholungen und nach Jobs, die ein Absturz oder ein anderer Prozess liegen ließ. Sie führt einen Job nach dem anderen aus. Scheitert ein solcher Durchgang als Ganzes, etwa weil Postgres nicht antwortet, nennt das Log den Fehler im Eintrag `job queue failed`, und der nächste Durchgang folgt nach einer Sekunde.

#### Cron-Jobs

Ein Cron-Job ist ein Job, den keine Mutation einreiht, sondern ein Zeitplan. Ein Plugin definiert ihn mit `defineCronJob()` und nennt ihn in `definePlugin({ manifest, cronJobs })`:

```ts
export const sendDigest = defineCronJob({
	name: "sendDigest",
	schedule: "0 7 * * 1-5",
	maxAttempts: 3,
	run: async (job, ctx) => {},
});
```

- `schedule` ist ein Cron-Ausdruck aus fünf Feldern, in UTC: Minute (0 bis 59), Stunde (0 bis 23), Tag des Monats (1 bis 31), Monat (1 bis 12) und Wochentag (0 bis 7, 0 und 7 sind Sonntag). Ein Feld ist `*`, eine Zahl, ein Bereich (`1-5`) oder eine Liste davon (`0,30`), je mit optionaler Schrittweite (`*/15`, `10-50/20`). Namen wie `MON` oder `JAN` und Kürzel wie `@daily` gibt es nicht. Beginnt weder der Tag des Monats noch der Wochentag mit `*`, ist der Job fällig, wenn einer von beiden passt, wie bei `cron`: `0 0 13 * 5` läuft am 13. und an jedem Freitag. Beginnt eines der beiden Felder mit `*`, auch als `*/2`, müssen beide passen.
- Der Cron-Job teilt sich den Namensraum mit den Jobs des Plugins und heißt `<plugin>.<name>`.
- `job` nennt `id`, `name`, `attempt` und `dueAt`, die Fälligkeit, für die er läuft; `ctx` ist derselbe wie bei einem Job.

Ein Zeitplan, der nicht diese Form hat oder nie fällig wird (`0 0 30 2 *`), macht das Plugin ungültig (`invalid_manifest`). Ein seltener Zeitplan ist gültig, wie lang der Abstand zweier Fälligkeiten auch ist: `0 0 29 2 */7`, der 29. Februar an einem Sonntag, wird nach 2088 erst 2128 wieder fällig.

Der Core reiht jede Fälligkeit im Voraus ein: Ein Durchgang schreibt für jeden Cron-Job die nächste Fälligkeit nach dem Jetzt mit `due_at` nach `core.jobs`, und der Job läuft, sobald sie erreicht ist. Je Cron-Job und Fälligkeit gibt es höchstens eine Zeile (`UNIQUE (name, due_at)`); laufen zwei Prozesse gegen dieselbe Datenbank, legt nur einer sie an und nur einer führt sie aus. Von da an ist sie ein Job wie jeder andere, mit Versuchen, Wartezeit, Frist und Dead-Letter.

Dabei schließt der Core an die jüngste Fälligkeit an, die schon in `core.jobs` steht, nicht an das Jetzt. Sind seit ihr Fälligkeiten verstrichen, ohne eingereiht zu werden, weil ein Durchgang länger dauerte als der Abstand zweier Fälligkeiten oder weil keine Instanz lief, reiht er sie nach, höchstens die zehn jüngsten; `dueAt` nennt jeweils die Fälligkeit, für die der Job läuft.

- Solange je Cron-Job nicht mehr als zehn Fälligkeiten zwischen zwei Durchgängen verstreichen, läuft er für jede genau einmal, auch wenn ein Durchgang oder ein Stillstand sie überdeckt.
- Verstreichen mehr, etwa bei `* * * * *` nach einer Stunde Stillstand, läuft er für die eine, die schon eingereiht war, und für die zehn jüngsten; die dazwischen entfallen. Das Log meldet dann einmal die Warnung `cron due times skipped` mit `job` (dem Namen), `latestEnqueuedDueAt`, der Fälligkeit, die schon eingereiht war, und `oldestCaughtUpDueAt`, der ältesten nachgeholten; entfallen sind die Fälligkeiten zwischen den beiden. Ein Cron-Job, der keine auslassen darf, rechnet von `dueAt` aus selbst nach.
- Die Nachgeholten laufen nacheinander, die älteste zuerst, sobald eine Instanz läuft.
- Ein neuer Cron-Job läuft zum ersten Mal zur ersten Fälligkeit nach dem Start, an dem er aktiv wurde, nicht rückwirkend. War er früher schon einmal aktiv und steht noch eine Fälligkeit von damals in `core.jobs`, gilt sie als die jüngste, und er holt bis zu zehn nach.
- Eine bereits eingereihte Fälligkeit bleibt bestehen, wenn sich der Zeitplan ändert, und läuft noch einmal nach dem alten; nachgeholt wird nach dem neuen.
- Eine Wiederholung kann sich mit der nächsten Fälligkeit überschneiden; `dueAt` und `id` unterscheiden die beiden.

### Test-Harness

Plugins testen ihre Operationen als „Akteur ruft Operation auf“ gegen ein echtes Postgres (ADR-0011). Das Harness aus `@workbench/core/testing` legt eine eigene Datenbank an, migriert `core` und die Schemas der Plugins, aktiviert die Plugins und ruft Operationen über dieselbe Pipeline auf wie die Instanz:

```ts
import {
	pluginPackageAt,
	startOperationHarness,
} from "@workbench/core/testing";

const harness = await startOperationHarness({
	plugins: [await pluginPackageAt(join(import.meta.dir, ".."))],
});
const workspace = await harness.createWorkspace("Alpha");
const result = await harness.call({
	actor: { kind: "user", id: "alice" },
	workspace,
	operation: "board.renameLabel",
	input: { label: "Urgent" },
});
await harness.stop();
```

Ein Aufruf kann einen `idempotencyKey` nennen; ohne ihn gilt er als Aufruf ohne Key (siehe [Idempotency-Keys](#idempotency-keys)).

`result` ist `{ ok: true, output }` oder `{ ok: false, failure }` mit `code`, `kind`, `detail` und `issues`. Ohne Angabe gibt das Harness eine feste Uhr (`2026-11-26T08:00:00.000Z`), fortlaufende IDs im UUID-Format (`00000000-0000-4000-8000-000000000001`, …), den Audit-Einträgen fortlaufende IDs aus einer eigenen Folge (`00000000-0000-4000-a000-000000000001`, …), sodass eine Mutation die IDs der folgenden Operationen nicht verschiebt, den Events fortlaufende IDs aus einer dritten Folge (`00000000-0000-4000-e000-000000000001`, …), den Jobs aus einer vierten (`00000000-0000-4000-b000-000000000001`, …), `random()` = `0.5` und jedem Aufruf eine fortlaufende Correlation-ID (`harness-call-1`, …), unter der die Pipeline loggt; `now`, `newId`, `newAuditEntryId`, `random` und `newCorrelationId` lassen sich als Optionen übergeben. Lädt ein Plugin nicht, wirft `startOperationHarness` einen `HarnessStartError` mit dem Ladefehler. `harness.logEntries` enthält die Log-Einträge.

Events stellt das Harness nicht von selbst zu: `await harness.deliverEvents()` ruft die Handler aller fälligen Zustellungen auf und kehrt zurück, wenn jede einmal versucht ist. Eine gescheiterte Zustellung wird erst wieder fällig, wenn die Uhr des Harness (`now`) weiter ist als ihre Wartezeit. Stellt ein Test die Uhr um Tage vor, legt `deliverEvents()` wie die Instanz die Zustellungen in den Dead-Letter, deren Zustellfrist abgelaufen ist, und löscht die Events aus der Outbox, deren Zustellungen alle seit 7 Tagen gelungen oder im Dead-Letter sind.

Auch Jobs führt das Harness nicht von selbst aus: `await harness.runJobs()` versucht jeden fälligen Job einmal und kehrt dann zurück. Ein gescheiterter Job wird erst wieder fällig, wenn die Uhr des Harness (`now`) weiter ist als seine Wartezeit; ein Test stellt die Uhr vor, statt zu warten. Für einen Cron-Job reiht der erste Aufruf die nächste Fälligkeit nach der Uhr des Harness ein; ist die Uhr danach bei ihr angekommen, führt der nächste Aufruf ihn aus, auch für die Fälligkeiten, über die der Test die Uhr hinweggestellt hat, höchstens die zehn jüngsten. Stellt ein Test die Uhr um Tage vor, löscht `runJobs()` wie die Instanz erledigte Jobs nach 7 und Jobs im Dead-Letter nach 30 Tagen aus `core.jobs`.

Das Referenz-Plugin bietet so die Mutation `reference.createNote` (Eingabe `title`, 1 bis 200 Zeichen nach Entfernen von Leerraum am Rand) und die Query `reference.listNotes` (Eingabe `limit`, 1 bis 100; die neuesten zuerst), beide auf den Notizen eines Workspaces in `plugin_reference.notes`. `reference.createNote` publiziert das Event `reference.NoteCreated` (Version 1, Payload `noteId`), dessen Definition `noteCreated` im Contract des Plugins liegt (siehe [Events](#events)). Seine Tests in `packages/plugin-reference/src/operations.test.ts` zeigen das Harness im Einsatz.

### HTTP-API

Jede Operation des Cores und der aktiven Plugins ist per HTTP erreichbar, als dünner Adapter auf dieselbe Pipeline (ADR-0013):

```sh
curl -X POST "http://127.0.0.1:3000/api/workspaces/$WORKSPACE/operations/reference.createNote" \
	-H "Authorization: Bearer $TOKEN" \
	-d '{"title":"Plan"}'
```

- Der Pfad ist `POST /api/workspaces/{workspace}/operations/{operation}`, auch für eine Query. Der Body ist die Eingabe als JSON, höchstens 1 MiB (1048576 Bytes); die Antwort 200 enthält die Ausgabe der Operation. Eine andere Methode auf diesem Pfad beantwortet die API vor der Prüfung des Tokens mit 405 und `Allow: POST`, als Problem Details mit `code` `method_not_allowed`.
- `GET /api/operations` listet die Operationen des Cores und der aktiven Plugins, nach Namen sortiert, je mit Namen und Art: `{"operations":[{"name":"reference.createNote","kind":"mutation"}, …]}`. Er braucht wie jeder Aufruf ein API-Token; eine andere Methode beantwortet die API vor der Prüfung des Tokens mit 405 und `Allow: GET` (`method_not_allowed`).
- Jeder Aufruf braucht ein API-Token als `Authorization: Bearer <token>`; das Schema `Bearer` gilt in beliebiger Groß- und Kleinschreibung (RFC 9110). Fehlt es, steht es in einem anderen Schema, ist es unbekannt oder abgelaufen, antwortet die API mit 401 und `WWW-Authenticate: Bearer`, als Problem Details mit `code` `unauthenticated`. Die Antwort sagt nicht, welcher Fall vorlag; das Log nennt ihn im Eintrag `request not authenticated` mit `reason` (`missing_token`, `unknown_token`, `expired_token`). Der Akteur des Aufrufs ist der Service-Account des Tokens.
- Den Idempotency-Key einer Mutation nennt der Header `Idempotency-Key` (siehe [Idempotency-Keys](#idempotency-keys)), als Text (`Idempotency-Key: retry-1`) oder als String der Structured Fields nach RFC 9651 in Anführungszeichen (`Idempotency-Key: "retry-1"`), wie im Entwurf der IETF; beide nennen denselben Key. Weil ein Key kein Komma enthält, scheitert eine Mutation mit einem doppelt geschickten Header mit `invalid_idempotency_key`: Der Server sieht zwei Header als einen Wert, durch `, ` getrennt. Eine Wiederholung antwortet mit 200 und demselben Body wie der erste Aufruf. Eine Query beachtet den Header nicht.
- Jede Datenbankanweisung einer Anfrage darf höchstens 60 s dauern (`statement_timeout`); dauert sie länger, scheitert die Anfrage.
- Jedes Scheitern kommt als Problem Details mit `Content-Type: application/problem+json` und der Korrelations-ID in `correlationId`, mit dem Status nach der Art (siehe [Aufruf einer Operation](#aufruf-einer-operation)). Ein interner Fehler nennt nur `internal_error` und eine neutrale Meldung, nie Stacktrace, Pfad oder Query; die Details stehen unter derselben Korrelations-ID im Log.

| Code                      | Status | Bedeutung                                                                                                                       |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `unauthenticated`         | 401    | Kein gültiges API-Token.                                                                                                        |
| `invalid_input`           | 400    | Der Body ist kein JSON, oder die Eingabe passt nicht zum Eingabe-Schema.                                                        |
| `route_not_found`         | 404    | Weder Methode noch Pfad passen zu einer Route.                                                                                  |
| `method_not_allowed`      | 405    | Der Pfad einer Operation oder der MCP-Endpunkt mit anderer Methode als `POST`, die Liste der Operationen mit anderer als `GET`. |
| `malformed_path`          | 400    | Der Pfad enthält eine ungültige Prozent-Kodierung.                                                                              |
| `invalid_workspace_id`    | 400    | Der Workspace im Pfad oder im Argument `workspace` eines MCP-Tools ist keine UUID.                                              |
| `workspace_not_found`     | 404    | Kein Workspace hat diese UUID.                                                                                                  |
| `unknown_operation`       | 404    | Weder der Core noch ein aktives Plugin hat eine Operation dieses Namens.                                                        |
| `body_too_large`          | 413    | Der Body ist größer als 1 MiB.                                                                                                  |
| `invalid_idempotency_key` | 400    | Der Header `Idempotency-Key` hat nicht 1 bis 255 sichtbare ASCII-Zeichen oder Leerzeichen ohne Komma, oder er kam mehrfach.     |
| `idempotency_key_reused`  | 422    | Der Idempotency-Key kam schon mit einer anderen Operation, einem anderen Workspace oder einem anderen Body.                     |
| `instance_not_ready`      | 503    | Die Instanz startet noch oder ihr Start ist gescheitert.                                                                        |
| `internal_error`          | 500    | Die Anfrage scheiterte aus einem internen Grund.                                                                                |

#### Service-Account und API-Token anlegen

Den ersten Service-Account samt API-Token legt der Betreiber im Container an:

```sh
bun run create-service-account --name "deploy agent" --valid-days 90
```

Das Kommando liest dieselben Umgebungsvariablen wie die Instanz (mindestens `DATABASE_URL` oder `DATABASE_URL_FILE`), migriert bei Bedarf das Schema `core`, legt den Service-Account an und schreibt eine JSON-Zeile auf die Standardausgabe:

```json
{
	"serviceAccount": "7d4b…",
	"token": "wbt_…",
	"expiresAt": "2027-02-25T08:00:00.000Z"
}
```

- `--name` ist 1 bis 200 Zeichen lang (nach Entfernen von Leerraum am Rand), `--valid-days` eine ganze Zahl von 1 bis 3650; das Token gilt bis `expiresAt`, ausschließlich. Jede Datenbankanweisung des Kommandos darf höchstens 60 s dauern.
- Der Klartext des Tokens erscheint nur in dieser Ausgabe. Die Instanz speichert nur seinen SHA-256-Hash (ADR-0012); ein verlorenes Token lässt sich nicht wieder anzeigen, sondern nur neu anlegen.
- Fehlt eine Option, ist ein Wert ungültig oder ist eine Option unbekannt, endet das Kommando mit Exit-Code 1 und der Zeile `usage: create-service-account …` auf der Standardfehlerausgabe. Scheitert die Datenbank, endet es mit Exit-Code 1 und dem Log-Eintrag `service account not created` mit `reason` (`core_schema_not_migrated` oder `database_failed`) auf der Standardfehlerausgabe.

Scope (Operationen, Workspaces), Widerruf und Rechte folgen mit Identität und Zugriff; bisher darf jedes gültige Token jede Operation in jedem Workspace aufrufen.

#### API-Vertrag

`docs/openapi.json` beschreibt die HTTP-API als OpenAPI 3.1, erzeugt aus den Operationen des Cores und aller Plugin-Pakete im Repository:

```sh
bun run openapi
```

Die Liste der Operationen erscheint als `listOperations`. Jede Operation erscheint mit ihrem Namen als `operationId`, Ein- und Ausgabe-Schema als JSON Schema und Problem Details für jedes Scheitern. Die Schemas kommen aus [Standard JSON Schema](https://standardschema.dev) (`~standard.jsonSchema`, etwa von zod 4); ein Schema ohne diese Erweiterung erscheint als `{}`. `bun run check` scheitert, wenn die Datei nicht zu den Operationen passt; dann `bun run openapi` ausführen und das Ergebnis committen.

### MCP

Jede Operation des Cores und der aktiven Plugins ist auch als Tool des [Model Context Protocol](https://modelcontextprotocol.io) erreichbar, als dünner Adapter auf dieselbe Pipeline wie die HTTP-API (ADR-0018). Ein MCP-Client verbindet sich per Streamable HTTP mit `http://<host>/api/mcp` und schickt das API-Token als Header, etwa für Claude Code:

```sh
claude mcp add --transport http workbench "http://127.0.0.1:3000/api/mcp" --header "Authorization: Bearer $TOKEN"
```

- Der Endpunkt nimmt nur `POST` an, zustandslos und ohne Session; die Antwort ist JSON, kein SSE-Stream. `GET` und `DELETE` beantwortet er vor der Prüfung des Tokens mit 405 und `Allow: POST`, als Problem Details mit `code` `method_not_allowed`. Solange die Instanz startet oder ihr Start gescheitert ist, antwortet er wie die HTTP-API mit 503 (`instance_not_ready`).
- Jede Anfrage braucht ein gültiges API-Token als `Authorization: Bearer <token>`, wie die HTTP-API: Ohne gültiges Token antwortet der Endpunkt mit 401 und `WWW-Authenticate: Bearer` (`unauthenticated`), listet keine Tools und ruft keines auf; das Log nennt den Grund im Eintrag `request not authenticated`. OAuth bietet der Endpunkt nicht an. Der Akteur eines Aufrufs ist der Service-Account des Tokens, und eine Mutation schreibt wie über HTTP einen Audit-Eintrag mit dem Token.
- Der Name eines Tools ist der Name der Operation mit `_` statt `.`, etwa `reference_createNote` für `reference.createNote`. Seine Argumente sind `workspace`, die UUID des Workspace, und `input`, die Eingabe der Operation; das Eingabe-Schema des Tools nennt unter `input` das JSON Schema aus dem [API-Vertrag](#api-vertrag). Eine Query trägt die Annotation `readOnlyHint: true`. Der Server nennt sich `workbench` in der Version des [API-Vertrags](#api-vertrag) (`info.version`). Ein Tool-Name, den die Liste der Tools nicht nennt, auch der Name der Operation selbst, scheitert als Tool-Fehler mit `unknown_operation`.
- Das Ergebnis eines Tools ist ein Textblock mit der Ausgabe als JSON, mit denselben Feldern und Werten wie der Body der HTTP-API. Scheitert ein Aufruf, ist das Ergebnis ein Tool-Fehler (`isError: true`), dessen Text die Problem Details der HTTP-API mit demselben `code` sind (siehe die Tabelle unter [HTTP-API](#http-api)); fehlt `workspace` oder ist es keine UUID, ist der Code `invalid_workspace_id`.
- Den [Idempotency-Key](#idempotency-keys) einer Mutation nennt das Argument `idempotencyKey`, ein String; das Eingabe-Schema eines Tools nennt es nur an einer Mutation. Es ist derselbe Key wie im Header `Idempotency-Key` der HTTP-API: Ein Aufruf über MCP mit dem Key eines Aufrufs über HTTP desselben Akteurs erhält dessen Antwort. Ist das Argument bei einer Mutation kein gültiger Key, auch kein String, scheitert der Aufruf als Tool-Fehler mit `invalid_idempotency_key`; eine Query beachtet es nicht.
- Der Body einer Anfrage ist höchstens 1 MiB groß; einen größeren lehnt der Endpunkt mit 413 als Fehler von JSON-RPC ab.

### CLI

Jede Operation des Cores und der aktiven Plugins ist auch auf der Kommandozeile erreichbar, als dünner Client der [HTTP-API](#http-api) einer laufenden Instanz (ADR-0019). Das Kommando braucht nur Bun und das Repository, keinen Zugang zur Datenbank:

```sh
export WORKBENCH_URL=http://127.0.0.1:3000
bun run workbench operations
bun run workbench reference create-note --workspace "$WORKSPACE" --input '{"title":"Plan"}'
```

- `workbench operations` listet die Operationen der Instanz aus `GET /api/operations`, je Zeile das CLI-Kommando, den Namen der Operation und ihre Art, durch Tabulatoren getrennt, etwa `reference create-note`, `reference.createNote`, `mutation`.
- `workbench <plugin> <operation> --workspace <uuid> --input <json>` ruft eine Operation auf. `<operation>` ist ihr Name in kebab-case, aus `createNote` wird `create-note`; der Name selbst (`createNote`, `reference.createNote`) ist kein Kommando. `--input` ist die Eingabe als JSON, wie der Body der HTTP-API. Den [Idempotency-Key](#idempotency-keys) einer Mutation nennt `--idempotency-key <key>`; er ist derselbe Key wie im Header `Idempotency-Key`.
- Gelingt der Aufruf, schreibt das Kommando die Ausgabe als eine Zeile JSON auf die Standardausgabe, mit denselben Feldern und Werten wie der Body der HTTP-API, und endet mit Exit-Code 0.
- Scheitert er, schreibt es auf die Standardfehlerausgabe in der ersten Zeile `<code>: <detail>` aus den Problem Details der HTTP-API, mit demselben `code` (siehe die Tabelle unter [HTTP-API](#http-api)), darunter je Befund des Eingabe-Schemas eine eingerückte Zeile `<pfad>: <meldung>` und zuletzt `correlation id: <id>`, und endet mit Exit-Code 1:

  ```text
  invalid_input: the input does not match the input schema of the operation
    title: Too small: expected string to have >=1 characters
  correlation id: 4f0c…
  ```

- Ist die Instanz nicht erreichbar oder antwortet sie nicht binnen 120 s, meldet das Kommando `the instance at <origin> cannot be reached`; antwortet dort etwas anderes als die Instanz, etwa ein Proxy, `the instance answered with HTTP <status> and an unexpected body`, jeweils mit Exit-Code 1.
- Ein ungültiger Aufruf endet mit Exit-Code 2, bevor etwas die Instanz erreicht: ein unbekanntes Kommando oder eine unbekannte Option, ein fehlendes `--workspace` oder `--input`, eine Eingabe, die kein JSON ist (`--input is not JSON`). Die Standardfehlerausgabe nennt den Grund und darunter `usage: workbench …`, aber keinen übergebenen Wert.

Das API-Token kommt nie als Argument, damit es in keiner Prozessliste, Shell-History und keinem Log steht; eine Option `--token` gibt es nicht. Token und Adresse der Instanz kommen aus der Umgebung oder aus einer Konfigurationsdatei, die Umgebung geht je Wert vor:

| Variable           | Feld der Datei | Bedeutung                                                                                                                                                        |
| ------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKBENCH_URL`    | `url`          | Adresse der Instanz, `http://` oder `https://` mit Host; das Kommando nutzt nur ihren Origin. Pflicht.                                                           |
| `WORKBENCH_TOKEN`  | `token`        | Das API-Token. Pflicht. Secret.                                                                                                                                  |
| `WORKBENCH_CONFIG` | –              | Pfad der Konfigurationsdatei. Ohne Angabe `$XDG_CONFIG_HOME/workbench/cli.json`, sonst `$HOME/.config/workbench/cli.json`; fehlt diese Datei, gilt sie als leer. |

Die Konfigurationsdatei ist ein JSON-Objekt mit höchstens den Feldern `url` und `token`, beide Strings:

```json
{ "url": "https://workbench.example", "token": "wbt_…" }
```

Fehlt ein Pflichtwert, ist die Adresse ungültig, fehlt die Datei aus `WORKBENCH_CONFIG` oder ist eine Datei kein solches Objekt, endet das Kommando mit Exit-Code 2 und `invalid configuration:`, darunter je Befund eine Zeile, die Variable, Feld oder Datei nennt, nie einen Wert, etwa `WORKBENCH_TOKEN, or token in /home/ada/.config/workbench/cli.json is required`.

### Contract

Ein Plugin importiert aus einem anderen Plugin nur dessen Contract (ADR-0004). Ein Plugin-Paket veröffentlicht ihn als Subpath-Export `./contract`, der genau eine Datei nennt:

```json
{
	"name": "@workbench/plugin-board",
	"exports": { "./contract": "./src/contract/index.ts" }
}
```

Andere Plugins importieren ihn als `@workbench/plugin-board/contract`; das Referenz-Plugin veröffentlicht so `@workbench/plugin-reference/contract`. Der Contract ist das Verzeichnis dieser Datei, hier `src/contract/`, ohne die Tests darin. Er darf aus mehreren Dateien bestehen und enthält nur Typen, Schemas, Event-Definitionen und Werte-Typen.

Die Architekturtests in `packages/architecture` lassen `bun run check` scheitern, wenn

- ein Plugin aus einem anderen Plugin etwas anderes als `<Paket>/contract` importiert, auch als reinen Typ-Import oder über einen relativen Pfad in dessen Verzeichnis,
- ein Plugin außerhalb seiner Tests `import(…)`, `require(…)`, `require.resolve(…)`, `import.meta.resolve(…)` oder `mock.module(…)` mit einem berechneten Modulpfad aufruft, etwa einer Variable, einer Verkettung oder einem Template-Literal mit `${…}` (`computed_import`); die Prüfung sieht nur Modulpfade, die als einfaches String-Literal dastehen,
- eine Datei des Contracts eine Datei ihres eigenen Pakets außerhalb des Contracts importiert, etwa Server- oder Client-Code des Plugins oder einen Test; erlaubt sind die übrigen Dateien des Contracts, andere Pakete und die Contracts fremder Plugins,
- die Datei, die `./contract` nennt, eine Datei des Contracts nicht über relative Importe erreicht; das Verzeichnis enthält dann Code, der kein Contract ist, etwa Client-Code neben `./src/contract.ts`,
- das Verzeichnis des Contracts den Einstieg des Plugins enthält oder `./contract` keine einzelne Datei nennt,
- ein Plugin außerhalb seiner Tests `defineEvent` in einer Datei nennt, die nicht zu seinem Contract gehört; die Prüfung sieht das Wort, nicht ein von Hand gebautes Objekt derselben Form (ADR-0015),
- der Core oder das SDK außerhalb ihrer Tests Begriffe der fachlichen Plugins enthält, etwa `kanban`, `issue tracker` oder `note`; die Liste steht in `packages/architecture/src/domain-language.ts`.
- der Core oder das SDK außerhalb ihrer Tests ein Plugin-Paket importiert, auch dessen Contract oder über einen relativen Pfad; der Kernel findet die Plugin-Pakete erst zur Laufzeit (ADR-0007).

## Umgebungsvariablen

Die Konfiguration kommt ausschließlich aus der Umgebung und wird beim Start geprüft. Fehlt eine Pflichtvariable oder ist ein Wert ungültig, endet der Start mit Exit-Code 1 und einer Meldung, die die Variable nennt, aber keinen Wert ausgibt. Leere Variablen gelten als nicht gesetzt. Zahlen sind ganze Dezimalzahlen ohne Vorzeichen, führende Nullen oder Leerraum; Schreibweisen wie `0x1F90` oder `1e3` werden abgelehnt.

| Variable                 | Pflicht | Standard | Bedeutung                                                                                                                                                                                             |
| ------------------------ | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | ja      | –        | Postgres-URL (`postgres://` oder `postgresql://`) mit Host. Secret.                                                                                                                                   |
| `DATABASE_URL_FILE`      | –       | –        | Pfad einer Datei mit der Postgres-URL (Docker-Secret). Ersetzt `DATABASE_URL`; beide zugleich sind ein Fehler.                                                                                        |
| `PORT`                   | nein    | `3000`   | HTTP-Port, 0 bis 65535 (0 wählt einen freien Port).                                                                                                                                                   |
| `LOG_LEVEL`              | nein    | `info`   | `debug`, `info`, `warn` oder `error`.                                                                                                                                                                 |
| `READINESS_TIMEOUT_MS`   | nein    | `2000`   | Frist der Datenbankprüfung im Readiness-Check in Millisekunden, 1 bis 60000.                                                                                                                          |
| `PLUGIN_HOOK_TIMEOUT_MS` | nein    | `10000`  | Frist in Millisekunden, die ein Plugin je für das Laden seines Einstiegs, für `activate`, für `deactivate`, für jeden Aufruf eines Event-Handlers und für jeden Versuch eines Jobs hat, 1 bis 600000. |
| `PLUGINS`                | nein    | –        | Namen der Plugins, die die Instanz aktiviert, durch Komma getrennt. Ohne Angabe ist kein Plugin aktiv.                                                                                                |

Für die Tests gilt zusätzlich `TEST_DATABASE_URL` (Standard: die Datenbank aus `compose.dev.yaml`).

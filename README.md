# Workbench

Selbst gehostete, erweiterbare Arbeitsoberfläche. Begriffe stehen in [`GLOSSARY.md`](GLOSSARY.md), Entscheidungen in [`docs/adr/`](docs/adr/).

Das Repository ist ein Bun-Monorepo. Der Core-Server liegt in `packages/core`, das SDK für Plugins in `packages/sdk`, jedes Plugin-Paket in einem eigenen Verzeichnis unter `packages/` (zuerst das Referenz-Plugin in `packages/plugin-reference`).

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

Die Datenbank lauscht auf `127.0.0.1:54329`, hält ihre Daten nur im Arbeitsspeicher und wird mit `docker compose -f compose.dev.yaml down` wieder entfernt. Eine andere Datenbank lässt sich über `TEST_DATABASE_URL` angeben. `compose.dev.yaml` dient nur der Entwicklung und ist keine Deployment-Datei.

## Prüfbefehl

```sh
bun run check
```

Der Befehl prüft Format und Lint (Biome), Typen (`tsc`) und führt die Tests aus. Der Workflow `ci` ruft genau diesen Befehl für jede Pull-Request und jeden Push auf `main` auf. `bun run format` behebt Format- und Lint-Befunde, soweit das automatisch geht.

## Server starten

```sh
DATABASE_URL=postgres://workbench:workbench@127.0.0.1:54329/workbench_test bun run --filter @workbench/core start
```

- `GET /health/live` meldet, dass der Prozess läuft, unabhängig von der Datenbank.
- `GET /health/ready` antwortet mit 200, wenn der Start der Instanz abgeschlossen ist und Postgres erreichbar ist, sonst mit 503. Der Server startet auch ohne Datenbank.

Beim Start wartet die Instanz, bis Postgres erreichbar ist (Log-Eintrag `database unreachable, retrying` mit `reason` und `retryInMs`; die Wartezeit wächst exponentiell mit Zufallsanteil bis höchstens 10 s). Danach migriert sie das Schema `core` und die Schemas der Plugins (siehe [Migrationen](#migrationen)), aktiviert die Plugins und meldet `instance started`; erst dann ist sie bereit. Schlägt eine Migration fehl, meldet das Log `instance failed to start` mit `reason` (`core_schema_not_migrated` oder `plugin_schema_not_migrated`), und die Instanz bleibt bis zum nächsten Start „nicht bereit“.

Kann der Server nicht starten, etwa weil der Port belegt ist, endet der Prozess mit Exit-Code 1 und einem Log-Eintrag `server failed to start`, der Port und Fehlercode (z. B. `EADDRINUSE`) nennt.

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

- `name` ist der Name, unter dem die Instanz-Config und andere Plugins das Plugin ansprechen: Kleinbuchstaben, Ziffern und Bindestriche, beginnend mit einem Buchstaben. Er muss dem Namen in der `package.json` gleichen. Die Version ist die `version` der `package.json`.
- `requires` nennt vorausgesetzte Plugins mit SemVer-Range (`^`, `~`, Vergleichsoperatoren, `x`/`*`, mit Leerzeichen oder `||` kombiniert).
- `capabilities` nennt die Capabilities, die das Plugin braucht. `ctx.capability(name)` liefert nur deklarierte und wirft sonst einen Fehler. Der Core bietet bisher nur `database` an (`DATABASE_CAPABILITY` aus `@workbench/sdk`); ein Manifest, das eine unbekannte deklariert, ist ungültig.

Beim Start entdeckt der Kernel die Plugin-Pakete, lädt die Einstiege der in `PLUGINS` genannten Plugins, löst ihre `requires` auf und aktiviert sie, vorausgesetzte zuerst. Von einem Plugin, das nicht in `PLUGINS` steht, läuft kein Code, und seine Mängel sind kein Ladefehler. Beim Shutdown (`SIGTERM`, `SIGINT`) stoppt erst der Server, dann werden die Plugins in umgekehrter Reihenfolge deaktiviert. Änderungen an `PLUGINS` wirken nach einem Neustart.

Jedes Plugin hat für das Laden seines Einstiegs, für `activate` und für `deactivate` je die Frist `PLUGIN_HOOK_TIMEOUT_MS`. Wird der Einstieg nicht rechtzeitig geladen, gilt das Plugin als nicht geladen (`load_timed_out`). Wird `activate` nicht rechtzeitig fertig, gilt das Plugin als nicht geladen (`activation_timed_out`) und der Start geht mit den übrigen weiter. Für ein Plugin, dessen `activate` fehlschlägt oder die Frist überschreitet, ruft der Kernel `deactivate` nicht auf; es muss selbst freigeben, was es bis dahin belegt hat. Wird `deactivate` nicht rechtzeitig fertig oder schlägt es fehl, nennt das Log das Plugin (`plugin deactivation timed out`, `plugin failed to deactivate`), die übrigen werden trotzdem deaktiviert, und die Instanz endet mit Exit-Code 1. Ein Signal während des Starts beendet den Start der Plugins: Der Kernel aktiviert kein weiteres Plugin (Log-Eintrag `plugin start stopped` mit den nicht aktivierten in `notActivated`), wartet auf ein gerade laufendes `activate` höchstens die Frist und deaktiviert dann die bereits aktiven Plugins. Lädt der Kernel beim Signal noch Einstiege, lädt er die der übrigen aktivierten Plugins zu Ende, je Plugin höchstens die Frist, und aktiviert danach keines.

Ein Paket, dessen `package.json` nicht lesbar ist oder `workbench.plugin` in anderer Form angibt, überspringt der Kernel; das Log nennt es als Eintrag `plugin package ignored` mit Verzeichnis (`directory`) und Grund (`problem`). Die übrigen Plugin-Pakete sind davon nicht betroffen.

Kann ein Plugin nicht geladen werden, startet die Instanz trotzdem. Das Log nennt jeden Ladefehler als Eintrag `plugin not loaded` mit `plugin`, `reason` und einer ausformulierten Meldung in `detail`; der Eintrag `plugins started` fasst aktive (`active`) und nicht geladene (`notLoaded`) Plugins zusammen. Hat Code des Plugins oder der Core beim Bereitstellen einer Capability einen Fehler geworfen, steht er mit Name, Meldung und Stacktrace in `error`, ebenso im Eintrag `plugin failed to deactivate`. Fehlermeldungen eines Plugins stehen damit im Log und dürfen keine Secrets enthalten.

| `reason`                 | Bedeutung                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `invalid_manifest`       | Manifest oder Paketversion ungültig, Einstieg nicht ladbar oder Name anders als im Paket.             |
| `load_timed_out`         | Der Einstieg des Plugins wurde nicht innerhalb von `PLUGIN_HOOK_TIMEOUT_MS` geladen.                  |
| `unknown_plugin`         | In `PLUGINS` genannt, aber kein Plugin-Paket stellt das Plugin bereit.                                |
| `duplicate_plugin`       | Mehrere Plugin-Pakete deklarieren denselben Plugin-Namen; keines davon wird geladen.                  |
| `missing_dependency`     | Kein Plugin-Paket stellt ein vorausgesetztes Plugin bereit, oder es ist nicht in `PLUGINS` aktiviert. |
| `version_mismatch`       | Die Version eines vorausgesetzten Plugins erfüllt die Range nicht.                                    |
| `dependency_not_loaded`  | Ein vorausgesetztes Plugin wurde selbst nicht geladen; `detail` nennt dessen Ursache.                 |
| `dependency_cycle`       | Plugins setzen einander im Kreis voraus; jedes Plugin des Kreises erhält diesen Grund.                |
| `capability_unavailable` | Der Core konnte eine deklarierte Capability nicht bereitstellen; `activate` wurde nicht aufgerufen.   |
| `migration_failed`       | Das Schema des Plugins konnte nicht migriert werden; `detail` nennt die Migration und den Fehler.     |
| `activation_failed`      | `activate` des Plugins ist fehlgeschlagen.                                                            |
| `activation_timed_out`   | `activate` des Plugins wurde nicht innerhalb von `PLUGIN_HOOK_TIMEOUT_MS` fertig.                     |

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
- Jeder Migrationslauf (erst `core`, dann die Schemas der Plugins) hält dieselbe Postgres-Advisory-Lock. Starten zwei Prozesse gleichzeitig, wartet der zweite und wendet nichts doppelt an.
- Schlägt eine Migration fehl, wird sie zurückgerollt; die folgenden Migrationen desselben Schemas laufen nicht, die anderer Schemas schon. Das Log nennt Schema, Migration und Fehler (`migration failed`), das Plugin wird nicht geladen (`migration_failed`), und die Instanz meldet nicht „bereit“.
- Nennt die `package.json` Migrationen, deklariert das Manifest aber nicht `database`, ist das Manifest ungültig.

## Umgebungsvariablen

Die Konfiguration kommt ausschließlich aus der Umgebung und wird beim Start geprüft. Fehlt eine Pflichtvariable oder ist ein Wert ungültig, endet der Start mit Exit-Code 1 und einer Meldung, die die Variable nennt, aber keinen Wert ausgibt. Leere Variablen gelten als nicht gesetzt. Zahlen sind ganze Dezimalzahlen ohne Vorzeichen, führende Nullen oder Leerraum; Schreibweisen wie `0x1F90` oder `1e3` werden abgelehnt.

| Variable                 | Pflicht | Standard | Bedeutung                                                                                                                        |
| ------------------------ | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | ja      | –        | Postgres-URL (`postgres://` oder `postgresql://`) mit Host. Secret.                                                              |
| `DATABASE_URL_FILE`      | –       | –        | Pfad einer Datei mit der Postgres-URL (Docker-Secret). Ersetzt `DATABASE_URL`; beide zugleich sind ein Fehler.                   |
| `PORT`                   | nein    | `3000`   | HTTP-Port, 0 bis 65535 (0 wählt einen freien Port).                                                                              |
| `LOG_LEVEL`              | nein    | `info`   | `debug`, `info`, `warn` oder `error`.                                                                                            |
| `READINESS_TIMEOUT_MS`   | nein    | `2000`   | Frist der Datenbankprüfung im Readiness-Check in Millisekunden, 1 bis 60000.                                                     |
| `PLUGIN_HOOK_TIMEOUT_MS` | nein    | `10000`  | Frist in Millisekunden, die ein Plugin je für das Laden seines Einstiegs, für `activate` und für `deactivate` hat, 1 bis 600000. |
| `PLUGINS`                | nein    | –        | Namen der Plugins, die die Instanz aktiviert, durch Komma getrennt. Ohne Angabe ist kein Plugin aktiv.                           |

Für die Tests gilt zusätzlich `TEST_DATABASE_URL` (Standard: die Datenbank aus `compose.dev.yaml`).

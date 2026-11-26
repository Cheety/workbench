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
- `GET /health/ready` antwortet mit 200, wenn Postgres erreichbar ist, sonst mit 503. Der Server startet auch ohne Datenbank.

Kann der Server nicht starten, etwa weil der Port belegt ist, endet der Prozess mit Exit-Code 1 und einem Log-Eintrag `server failed to start`, der Port und Fehlercode (z. B. `EADDRINUSE`) nennt.

Logs sind JSON-Zeilen auf der Standardausgabe. Jede Anfrage trägt eine Korrelations-ID: Ein gültiger Header `X-Correlation-ID` (höchstens 128 Zeichen aus Buchstaben, Ziffern, `.`, `_`, `-`) wird übernommen, sonst erzeugt der Server eine. Die Antwort nennt sie im selben Header.

## Plugins

Ein Plugin-Paket ist ein Paket unter `packages/`, dessen `package.json` unter `workbench.plugin` den Pfad seines Einstiegs nennt. Der Einstieg exportiert als Default das Ergebnis von `definePlugin()` aus `@workbench/sdk`:

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

- `name` ist der Name, unter dem die Instanz-Config und andere Plugins das Plugin ansprechen: Kleinbuchstaben, Ziffern und Bindestriche, beginnend mit einem Buchstaben. Die Version ist die `version` der `package.json`.
- `requires` nennt vorausgesetzte Plugins mit SemVer-Range (`^`, `~`, Vergleichsoperatoren, `x`/`*`, mit Leerzeichen oder `||` kombiniert).
- `capabilities` nennt die Capabilities, die das Plugin braucht. `ctx.capability(name)` liefert nur deklarierte und wirft sonst einen Fehler. Der Core bietet noch keine Capability an; ein Manifest, das eine unbekannte deklariert, ist ungültig.

Beim Start entdeckt der Kernel die Plugin-Pakete, löst `requires` für die in `PLUGINS` genannten Plugins auf und aktiviert sie, vorausgesetzte zuerst. Beim Shutdown (`SIGTERM`, `SIGINT`) stoppt erst der Server, dann werden die Plugins in umgekehrter Reihenfolge deaktiviert. Änderungen an `PLUGINS` wirken nach einem Neustart.

Kann ein Plugin nicht geladen werden, startet die Instanz trotzdem. Das Log nennt jeden Ladefehler als Eintrag `plugin not loaded` mit `plugin`, `reason` und einer ausformulierten Meldung in `detail`; der Eintrag `plugins started` fasst aktive (`active`) und nicht geladene (`notLoaded`) Plugins zusammen.

| `reason`                | Bedeutung                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `invalid_manifest`      | Manifest oder Paketversion ungültig, Einstieg nicht ladbar oder Plugin-Name doppelt vergeben. |
| `unknown_plugin`        | In `PLUGINS` genannt, aber kein Plugin-Paket stellt das Plugin bereit.                        |
| `missing_dependency`    | Ein vorausgesetztes Plugin ist nicht installiert oder nicht in `PLUGINS` aktiviert.           |
| `version_mismatch`      | Die Version eines vorausgesetzten Plugins erfüllt die Range nicht.                            |
| `dependency_not_loaded` | Ein vorausgesetztes Plugin wurde selbst nicht geladen; `detail` nennt dessen Ursache.         |
| `dependency_cycle`      | Plugins setzen einander im Kreis voraus.                                                      |
| `activation_failed`     | `activate` des Plugins ist fehlgeschlagen.                                                    |

## Umgebungsvariablen

Die Konfiguration kommt ausschließlich aus der Umgebung und wird beim Start geprüft. Fehlt eine Pflichtvariable oder ist ein Wert ungültig, endet der Start mit Exit-Code 1 und einer Meldung, die die Variable nennt, aber keinen Wert ausgibt. Leere Variablen gelten als nicht gesetzt. Zahlen sind ganze Dezimalzahlen ohne Vorzeichen, führende Nullen oder Leerraum; Schreibweisen wie `0x1F90` oder `1e3` werden abgelehnt.

| Variable               | Pflicht | Standard | Bedeutung                                                                                                      |
| ---------------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | ja      | –        | Postgres-URL (`postgres://` oder `postgresql://`) mit Host. Secret.                                            |
| `DATABASE_URL_FILE`    | –       | –        | Pfad einer Datei mit der Postgres-URL (Docker-Secret). Ersetzt `DATABASE_URL`; beide zugleich sind ein Fehler. |
| `PORT`                 | nein    | `3000`   | HTTP-Port, 0 bis 65535 (0 wählt einen freien Port).                                                            |
| `LOG_LEVEL`            | nein    | `info`   | `debug`, `info`, `warn` oder `error`.                                                                          |
| `READINESS_TIMEOUT_MS` | nein    | `2000`   | Frist der Datenbankprüfung im Readiness-Check in Millisekunden, 1 bis 60000.                                   |
| `PLUGINS`              | nein    | –        | Namen der Plugins, die die Instanz aktiviert, durch Komma getrennt. Ohne Angabe ist kein Plugin aktiv.         |

Für die Tests gilt zusätzlich `TEST_DATABASE_URL` (Standard: die Datenbank aus `compose.dev.yaml`).

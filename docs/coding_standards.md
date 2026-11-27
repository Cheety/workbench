# Coding-Standards

Die Ermessensfragen, die keine Prüfung entscheidet. Alles Mechanische prüft `bun run check` (Biome, `tsc`, Tests, Architekturtests); das Verhalten der Instanz beschreibt die [README](../README.md), die Entscheidungen stehen in [adr/](adr/).

## Prüfungen

- `bun run check` wird grün, indem der Code korrekt wird. Regeln in `biome.json`, Flags in `tsconfig.json`, die Architekturtests in `packages/architecture` und die Tests selbst bleiben, wie sie sind. Muss eine Regel sich ändern, geschieht das in einem eigenen Commit mit Begründung und nach Rückfrage.
- Strenger machen ist erwünscht: Wer ein fachliches Plugin anlegt, trägt dessen Kernbegriffe in Einzahl und Mehrzahl in `packages/architecture/src/domain-language.ts` ein (ADR-0009).

## Namen

- Begriffe kommen aus [GLOSSARY.md](../GLOSSARY.md), in Code, Tests, Logs, Issues und Commits gleich. Ein Wort unter _Avoid_ ist ein Synonym, das der Begriff ersetzt: Plugin statt Modul, Capability statt Permission, Instanz statt Server. Ein Begriff, der fehlt, wird zuerst im Glossar geklärt (Skill `domain-modeling`), dann benutzt.
- Bezeichner sind englisch, Doku, ADRs und Glossar deutsch.
- Tests heißen nach dem Verhalten, als englischer Satz, den `describe` und `test` zusammen bilden: `describe("imports between plugins")` + `test("rejects an import from the inside of a foreign plugin")`.

## Grenzen

- Core und SDK kennen keine Fachsprache der Plugins und importieren kein Plugin-Paket (ADR-0004, ADR-0007). Fachliche Funktion kommt als Plugin; der Workspace ist die einzige Ausnahme (ADR-0002).
- Ein Plugin importiert aus einem anderen nur `<Paket>/contract`. Der Contract enthält Typen, Schemas, Event-Definitionen und Werte-Typen, kein Verhalten.
- Ein Plugin liest und schreibt nur sein eigenes Schema `plugin_<name>` (ADR-0003). Fremde Daten kommen über den Contract oder ein eigenes, per Event gepflegtes Read Model.
- Modulpfade stehen als einfaches String-Literal da; einen berechneten Import sieht kein Architekturtest.

## Tests

- Zuerst der Test, der aus dem erwarteten Grund rot wird, dann der Code.
- Ein Test prüft, was ein Aufrufer sieht: Rückgabe, HTTP-Antwort, Log-Eintrag, Zustand in Postgres. Er bleibt grün, wenn sich nur die Implementierung ändert.
- Postgres läuft echt. Jeder Test, der eine Datenbank braucht, holt sich mit `createFreshDatabase()` aus `packages/core/src/testing/postgres.ts` eine eigene und räumt sie mit `drop()` ab. Ausfälle der Datenbank (verweigert, stumm, wieder da) stellt `PostgresGate` aus derselben Datei her, nicht ein Mock.
- Log-Einträge prüft `recordingLogger()` aus `packages/core/src/testing/recording-logger.ts`, mit fester Uhr. Uhr, Timer und Zufall kommen als Parameter herein, damit der Test sie steuert.
- Ein Test wartet auf einen Zustand, den er sehen kann (eine Antwort, einen Log-Eintrag, eine Zeile), nie eine Dauer ab. Ein Test, der nur mit mehr Zeit grün wird, zeigt einen Fehler im Code.
- Fixture-Plugins in Tests dürfen eigene Fachlichkeit haben; die Architekturtests nehmen Tests aus.

## Betrieb

- Was ein Betreiber sieht, ist Vertrag: Log-Meldungen (`plugin not loaded`), Gründe (`unknown_plugin`, `migration_failed`), Umgebungsvariablen, Exit-Codes, Health-Endpunkte. Gründe sind stabile Wörter in snake_case, Meldungen kurze englische Sätze in Kleinschreibung. Wer eines davon hinzufügt oder ändert, aktualisiert die README im selben Commit.
- Konfiguration liest nur `packages/core/src/config.ts` aus der Umgebung, prüft sie beim Start und meldet die Variable, nie ihren Wert. Ein Secret ist ein `Secret` und gibt seinen Wert nur über `reveal()` heraus.
- Eine angewandte Migration wird nie geändert, umbenannt oder umsortiert; der Dateiname ist ihr Schlüssel (ADR-0008). Eine große Datenänderung gehört in einen Batch-Job, keine Anweisung darf 60 s überschreiten.

## Entscheidungen

- Eine Entscheidung mit erwogenen Alternativen (neue Abhängigkeit, neue Grenze, bewusste Abweichung von einer Regel) bekommt eine ADR unter `docs/adr/`, mit der nächsten freien Nummer und den verworfenen Optionen samt Grund.

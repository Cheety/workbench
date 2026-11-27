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
- Ein Plugin nennt `defineEvent` nur in Dateien seines Contracts, Tests ausgenommen; der Architekturtest sucht den Namen im Quelltext, auch in Kommentaren und Strings (ADR-0009).
- Ein Plugin liest und schreibt nur sein eigenes Schema `plugin_<name>` (ADR-0003). Fremde Daten kommen über den Contract oder ein eigenes, per Event gepflegtes Read Model.
- Modulpfade stehen als einfaches String-Literal da; einen berechneten Import sieht kein Architekturtest.

## Typen

- Jedes `any` ist ein Leck: Es schaltet die Typprüfung für alles ab, was hindurchfließt. Eine bekannte Form bekommt einen benannten Typ, eine unbekannte `unknown` und wird eingeengt, ein Typparameter eine Schranke (`<T extends PluginDefinition>`). Fremde Werte (Umgebung, `package.json`, JSON) werden einmal am Rand eingeengt, etwa per zod wie in `config.ts`.
- Eine Assertion (`as`, `x!`) ist ein verstecktes `any`. Erlaubt ist sie nur im validierenden Konstruktor eines Werte-Typs, direkt nach der Prüfung (`schemaName()` in `schema-name.ts`); `as const` und `satisfies` sind keine Assertionen.
- Eine Fallunterscheidung über eine Union nennt jedes Mitglied: als `Record<Union, …>` (wie `EXPECTATIONS` in `config.ts`) oder als `switch` ohne `default`. Ein neues Mitglied, etwa ein neuer Grund eines Ladefehlers, bricht dann `tsc`, bis jede Stelle entschieden hat, statt still im Rückfallzweig zu landen.
- Optionale Parameter und Felder sind verdächtig: Wer sie weglässt, bekommt still ein Verhalten, das niemand gewählt hat. Ein Parameter ist Pflicht, außer das Weglassen ist fachlich richtig.

## Fehler

- Geworfen wird ein `Error` oder eine Unterklasse mit eigenem `name` (`InvalidSchemaNameError`), nie ein String oder Objekt; sonst fehlen Stacktrace und `instanceof`.
- Jedes Promise wird mit `await` erwartet, per `.catch` behandelt oder bewusst mit `void` als Fire-and-forget markiert (`void shutDownInstance(…)` im Signal-Handler). Eine `async`-Funktion geht nie an eine Stelle, die einen `void`-Callback erwartet (`forEach`, Event-Listener), weil dort niemand ihre Ablehnung fängt.
- Ein `catch` übersetzt den Fehler in ein Ergebnis (`{ reachable: false, reason }`, einen Ladefehler), loggt ihn mit `describeThrown()` oder wirft ihn weiter. Er fängt nur, was er erwartet, und wirft den Rest unverändert weiter (`main.ts`).

## Globale APIs

- Jede globale API hat einen Besitzer: `process.env` liest nur `config.ts` (in Tests `testing/postgres.ts`), Uhr (`new Date()`) und Zufall (`Math.random`) erzeugt `main.ts` und reicht sie als Parameter hinein, eine Frist, deren Ablauf ein Test steuern muss, kommt als `SetTimer` aus `hook-timeout.ts` herein, und statt `console` schreibt jeder über den `Logger`. So steuert ein Test Zeit, Zufall und Fristen, statt auf sie zu warten.

## Kommentare

- Ein Kommentar sagt nur, was der Code nicht zeigen kann: warum, etwa eine Bedingung von Postgres. Was der Code tut, sagen seine Namen; Entscheidungen stehen in ADRs.

## Tests

- Zuerst der Test, der aus dem erwarteten Grund rot wird, dann der Code.
- Ein Test prüft, was ein Aufrufer sieht: Rückgabe, HTTP-Antwort, Log-Eintrag, Zustand in Postgres. Er bleibt grün, wenn sich nur die Implementierung ändert.
- Postgres läuft echt, in der Hauptversion der Produktion: `createFreshDatabase()` lehnt einen Server anderer Hauptversion mit `UnsupportedPostgresVersionError` ab. Jeder Test, der eine Datenbank braucht, holt sich mit `createFreshDatabase()` aus `packages/core/src/testing/postgres.ts` eine eigene und räumt sie mit `drop()` ab. Ausfälle der Datenbank (verweigert, stumm, wieder da) stellt `PostgresGate` aus derselben Datei her, nicht ein Mock.
- Log-Einträge prüft `recordingLogger()` aus `packages/core/src/testing/recording-logger.ts`, mit fester Uhr.
- Jeder Test kann an einem plausiblen Fehler scheitern, den ein Aufrufer oder Betreiber bemerken würde. Lässt sich dieser Fehler nicht benennen, entfällt der Test.
- Tests verbinden sich nur mit Datenbanken aus `packages/core/src/testing/postgres.ts` (`TEST_DATABASE_URL` oder `createFreshDatabase()`), nie mit `DATABASE_URL`.
- Ein Test wartet auf einen Zustand, den er sehen kann (eine Antwort, einen Log-Eintrag, eine Zeile), nie eine Dauer ab. Ein Test, der nur mit mehr Zeit grün wird, zeigt einen Fehler im Code.
- Fixture-Plugins in Tests dürfen eigene Fachlichkeit haben; die Architekturtests nehmen Tests aus.

## Betrieb

- Was ein Betreiber sieht, ist Vertrag: Log-Meldungen (`plugin not loaded`), Gründe (`unknown_plugin`, `migration_failed`), Umgebungsvariablen, Exit-Codes, Health-Endpunkte. Gründe sind stabile Wörter in snake_case, Meldungen kurze englische Sätze in Kleinschreibung. Wer eines davon hinzufügt oder ändert, aktualisiert die README im selben Commit.
- Konfiguration liest nur `packages/core/src/config.ts` aus der Umgebung, prüft sie beim Start und meldet die Variable, nie ihren Wert. Ein Secret ist ein `Secret` und gibt seinen Wert nur über `reveal()` heraus.
- Eine angewandte Migration wird nie geändert, umbenannt oder umsortiert; der Dateiname ist ihr Schlüssel (ADR-0008). Eine große Datenänderung gehört in einen Batch-Job, keine Anweisung darf 60 s überschreiten.

## Entscheidungen

- Eine Entscheidung mit erwogenen Alternativen (neue Abhängigkeit, neue Grenze, bewusste Abweichung von einer Regel) bekommt eine ADR unter `docs/adr/`, mit der nächsten freien Nummer und den verworfenen Optionen samt Grund.

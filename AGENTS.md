# AGENTS.md

Die Workbench: selbst gehostete, erweiterbare Arbeitsoberfläche als Bun-Monorepo; der Core lädt Plugins, jede fachliche Funktion ist ein Plugin.

- [GLOSSARY.md](GLOSSARY.md): die Fachsprache. Namen in Code, Tests und Logs nutzen ihre Begriffe.
- `bun run check` ist das Gate: Format und Lint (Biome), Typen, alle Tests samt Architekturtests, gegen das Postgres aus `compose.dev.yaml`. Vor jedem Commit grün sehen; die CI ruft genau diesen Befehl.
- [docs/coding_standards.md](docs/coding_standards.md): die Ermessensfragen, die keine Prüfung entscheidet. Vor dem Schreiben von Code lesen.
- [docs/verification.md](docs/verification.md): wie man Datenbank und Server startet, Health, Migrationen und Ladefehler prüft, um zu zeigen, dass eine Änderung wirkt.
- [README.md](README.md): das Verhalten, das ein Betreiber sieht (Umgebungsvariablen, Log-Einträge, Ladefehler, Migrationen, Contract). Ändert sich davon etwas, im selben Commit nachziehen.
- [docs/adr/](docs/adr/): warum der Code so geschnitten ist.

## Agent skills

### Issue tracker

Issues live in GitHub Issues of `Cheety/workbench`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

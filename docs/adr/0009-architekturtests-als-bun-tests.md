# Architekturtests sind eigene Bun-Tests im Paket `@workbench/architecture`

ADR-0002 und ADR-0004 verlangen Architekturtests: Ein Plugin importiert aus einem anderen nur dessen Contract, der Contract hängt nicht vom Server- oder Client-Teil seines Plugins ab, und der Core enthält außer dem Workspace keine Fachsprache. Die Prüfungen sind eigener Code, der als `bun test` läuft und damit Teil von `bun run check` ist; ein Architekturtest-Werkzeug war freigegeben, wird aber nicht eingesetzt. Erwogen wurde dependency-cruiser: Es kennt keine Plugin-Pakete, die Regeln müssten Paketnamen und Contract-Verzeichnisse als Pfadmuster wiederholen, statt sie wie der Kernel aus `workbench.plugin` und `exports` zu lesen (ADR-0007), und es wäre eine weitere Abhängigkeit mit eigener Konfigurationssprache.

Die Prüfungen liegen in einem eigenen Paket `packages/architecture`, nicht im Core. Erwogen wurde der Core; dann stünde die Liste der Fachbegriffe in dem Code, den sie prüft, und Code, der nie zur Laufzeit läuft, läge im Core.

Ein Plugin-Paket ist wie beim Kernel ein Paket, dessen `package.json` `workbench.plugin` nennt. Sein Contract ist genau die eine Datei, die `exports["./contract"]` nennt. Sie importiert keine Datei ihres eigenen Pakets, sondern nur andere Pakete und die Contracts fremder Plugins; so erreicht ein Import des Contracts keinen Server- oder Client-Code des Plugins, gleich wie das Paket aufgeteilt ist. Das Verzeichnis dieser Datei darf zudem den Einstieg des Plugins nicht enthalten, damit der Contract nie der Einstieg selbst ist. Erwogen wurde, das Verzeichnis der Datei als Contract zu nehmen; dann zählte bei `./src/contract.ts` ganz `src/` zum Contract, Client-Code daneben eingeschlossen. Erwogen wurde auch, den Contract als die Dateien zu bestimmen, die der Export über Importe erreicht; dann wäre jede vom Contract importierte Datei selbst Contract, und die Regel könnte nie verletzt sein. Ebenso erwogen wurden feste Verzeichnisse `server/`, `client/` und `contract/`; das wäre Verdrahtung über Namen statt über eine ausdrückliche Angabe.

Importe findet die Prüfung über die Modulpfade im Quelltext, reine Typ-Importe eingeschlossen. Erwogen wurde `Bun.Transpiler.scanImports`; es lässt Typ-Importe weg, und gerade sie sind zwischen Plugins der häufigste Weg ins Innere eines anderen.

Fachsprache ist eine feste Liste von Begriffen der geplanten fachlichen Plugins und des Referenz-Plugins (etwa `kanban`, `issue tracker`, `note`). Die Prüfung zerlegt jede Datei des Core in Wörter (Bezeichner, Strings, SQL) und sucht die Begriffe darin, auch im Plural. Tests des Core sind ausgenommen, weil ihre Fixture-Plugins eigene Fachlichkeit haben. `issue` allein steht nicht auf der Liste, weil der Core das Wort für Befunde einer Validierung braucht (`ConfigIssue`, `error.issues` von zod); erfasst wird `issue tracker`.

## Consequences

- Die Liste der Fachbegriffe ist nie vollständig. Wer ein fachliches Plugin anlegt, trägt dessen Kernbegriffe in `packages/architecture/src/domain-language.ts` ein.
- Die Prüfung sieht nur Modulpfade, die als Literal im Quelltext stehen; ein berechneter dynamischer Import entgeht ihr. Ein Text in Kommentar oder String, der wie ein Import aussieht, zählt dagegen mit.
- Ein Contract kann nicht als Bedingungsobjekt (`{ "types": …, "default": … }`) exportiert werden, sondern nennt genau eine Datei.
- Ein Contract steht in einer einzigen Datei. Wird sie zu groß, braucht es eine neue Regel, die mehrere Dateien zulässt, ohne Server- oder Client-Code einzuschließen.
- Ob der Core Plugin-Pakete importiert (ADR-0007), prüft bisher keiner der Tests.

# Contracts liegen im Plugin-Paket als eigener Export

Plugins dürfen einander nicht importieren, brauchen für Services und Events aber gemeinsame TypeScript-Typen. Jedes Plugin-Paket veröffentlicht deshalb seinen Contract als eigenen Subpath-Export (z. B. `@workbench/plugin-issues/contract`): nur Typen, Schemas, Event-Definitionen und Werte-Typen, kein Verhalten. Andere Plugins dürfen ausschließlich diesen Export importieren, und ein Architekturtest erzwingt das. Erwogen wurden ein separates Contract-Paket pro Plugin (doppelte Paketpflege) und zentrale Contracts im SDK (der Core müsste die Fachsprache der Plugins kennen).

## Consequences

- Der Contract wird mit dem Plugin-Paket nach SemVer versioniert; `requires` im Manifest bezieht sich damit auch auf den Contract.
- Der Contract-Export darf keine Laufzeitabhängigkeiten auf den Server- oder Client-Teil des Plugins haben, sonst zieht ein Import das ganze Plugin mit.

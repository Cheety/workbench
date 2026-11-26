# Der Kernel entdeckt Plugin-Pakete über ihre `package.json`

Der Kernel muss die Plugin-Pakete des Repos finden, ohne dass der Core von ihnen abhängt. Er liest dazu die Pakete im Verzeichnis `packages/`: Ein Paket ist ein Plugin-Paket, wenn seine `package.json` unter `workbench.plugin` den Pfad seines Einstiegs nennt; dessen Default-Export ist das Ergebnis von `definePlugin()`. Erwogen wurde eine feste Liste der Plugins im Core (der Core hinge von jedem Plugin-Paket ab und müsste für jedes neue Plugin geändert werden) und eine Namenskonvention wie `plugin-*` (Verdrahtung über Namen statt über eine ausdrückliche Angabe).

`definePlugin()` und die Manifest-Typen liegen in einem eigenen Paket `@workbench/sdk`. Core und Plugin-Pakete hängen beide davon ab und nie voneinander; läge `definePlugin()` im Core, entstünde ein Zyklus zwischen Core und Plugin-Paketen.

Ein Plugin, das nicht geladen werden kann, bricht den Start der Instanz nicht ab. Der Kernel protokolliert den Ladefehler und lädt die übrigen Plugins. Erwogen wurde, den Start wie bei ungültiger Konfiguration abzubrechen; dann nähme ein einzelnes fehlerhaftes Plugin die ganze Instanz mit, und der Betreiber sähe von mehreren Ladefehlern nur den ersten.

## Consequences

- Die Version eines Plugins ist die `version` seiner `package.json` und steht nicht noch einmal im Manifest; `requires` bezieht sich darauf (ADR-0004).
- Der Name des Plugins steht im Manifest. Der Kernel lädt deshalb den Einstieg jedes entdeckten Plugin-Pakets, auch wenn die Instanz-Config das Plugin nicht aktiviert, und meldet ein ungültiges Manifest in jedem Fall. Code auf oberster Ebene eines Einstiegs läuft damit auch für nicht aktivierte Plugins; Wirkung gehört in `activate`.
- Das Container-Image muss die Plugin-Pakete neben dem Core in derselben Verzeichnisstruktur enthalten.
- Eine Instanz kann mit weniger Plugins laufen, als die Instanz-Config nennt. Ob das der Fall ist, steht nur im Log; Readiness berücksichtigt es nicht.

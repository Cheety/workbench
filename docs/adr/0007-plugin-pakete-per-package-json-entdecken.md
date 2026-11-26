# Der Kernel entdeckt Plugin-Pakete über ihre `package.json`

Der Kernel muss die Plugin-Pakete des Repos finden, ohne dass der Core von ihnen abhängt. Er liest dazu die Pakete im Verzeichnis `packages/`: Ein Paket ist ein Plugin-Paket, wenn seine `package.json` unter `workbench.plugin` den Namen des Plugins (`name`) und den Pfad seines Einstiegs (`entry`) nennt; dessen Default-Export ist das Ergebnis von `definePlugin()`. Erwogen wurde eine feste Liste der Plugins im Core (der Core hinge von jedem Plugin-Paket ab und müsste für jedes neue Plugin geändert werden) und eine Namenskonvention wie `plugin-*` (Verdrahtung über Namen statt über eine ausdrückliche Angabe).

`definePlugin()` und die Manifest-Typen liegen in einem eigenen Paket `@workbench/sdk`. Core und Plugin-Pakete hängen beide davon ab und nie voneinander; läge `definePlugin()` im Core, entstünde ein Zyklus zwischen Core und Plugin-Paketen.

Ein Plugin, das nicht geladen werden kann, bricht den Start der Instanz nicht ab. Der Kernel protokolliert den Ladefehler und lädt die übrigen Plugins. Erwogen wurde, den Start wie bei ungültiger Konfiguration abzubrechen; dann nähme ein einzelnes fehlerhaftes Plugin die ganze Instanz mit, und der Betreiber sähe von mehreren Ladefehlern nur den ersten.

Die Version eines Plugins ist die `version` seiner `package.json`; das Manifest nennt keine eigene, und `requires` prüft seine SemVer-Ranges gegen sie. Erwogen wurde ein Versionsfeld im Manifest; dann hätte ein Plugin-Paket zwei Versionen, die auseinanderlaufen können, obwohl sein Contract schon mit dem Paket versioniert wird (ADR-0004).

## Consequences

- Der Name des Plugins steht zweimal da: in der `package.json` und im Manifest. Der Kernel braucht ihn, bevor er Code des Plugins ausführt, denn er lädt nur die Einstiege der Plugins, die die Instanz-Config aktiviert; Code eines nicht aktivierten Plugins läuft nie, und seine Mängel sind kein Ladefehler. Weichen die beiden Namen voneinander ab, ist das Manifest ungültig. Erwogen wurde, den Namen nur im Manifest zu führen; dann müsste der Kernel jeden Einstieg laden, um zu erfahren, welches Plugin er vor sich hat.
- Deklarieren mehrere Plugin-Pakete denselben Plugin-Namen, lädt der Kernel keines davon und meldet für ein aktiviertes Plugin den Ladefehler `duplicate_plugin` mit allen beteiligten Paketen. Erwogen wurde, das erste Paket in Verzeichnisreihenfolge zu nehmen; dann entschiede ein Verzeichnisname stillschweigend, welcher Code läuft, und ein defektes Paket könnte ein intaktes verdecken.
- Das Container-Image muss die Plugin-Pakete neben dem Core in derselben Verzeichnisstruktur enthalten.
- Eine Instanz kann mit weniger Plugins laufen, als die Instanz-Config nennt. Ob das der Fall ist, steht nur im Log; Readiness berücksichtigt es nicht.

# Operationen stehen in der Plugin-Definition, ihre Schemas folgen Standard Schema

Ein Plugin deklariert seine Operationen in `definePlugin({ manifest, operations })`; der Kernel prüft sie beim Laden zusammen mit dem Manifest, und eine ungültige Operation macht das ganze Plugin ungültig (`invalid_manifest`). Erwogen wurde, Operationen in `activate` über `ctx` zu registrieren; dann stünden sie erst nach der Aktivierung fest, ein Fehler fiele erst dort auf, und Registry, OpenAPI-Vertrag und MCP-Tools hingen von Code ab, der zur Laufzeit beliebig verzweigt. Erwogen wurde auch ein eigener Ladefehler-Grund für Operationen; die Definition eines Plugins ist aber schon heute als Ganzes Gegenstand von `invalid_manifest` (etwa `activate must be a function`), und `detail` nennt die fehlerhafte Operation.

Die Registry setzt den Namen aus Plugin und Operation zusammen (`<plugin>.<verbObjekt>`). Weil Plugin-Namen eindeutig sind (ADR-0007), kann ein doppelter Name nur innerhalb eines Plugins entstehen und wird dort abgelehnt. Das Recht einer Operation muss zum eigenen Plugin gehören (`<plugin>.…`); erwogen wurde, Rechte anderer Plugins zuzulassen, dann hinge die Bedeutung einer Operation von der Rollenpflege eines fremden Plugins ab. Die Regel lässt sich später lockern, ohne ein bestehendes Plugin zu brechen.

Ein- und Ausgabe-Schema sind Werte nach der Schnittstelle [Standard Schema](https://standardschema.dev) (`~standard.validate`), die das SDK als eigenen Typ `Schema` beschreibt. zod 4 erfüllt sie, ebenso andere Validatoren. Erwogen wurde, zod-Typen im SDK zu verwenden; dann stünde ein fremder Bibliothekstyp in der öffentlichen API des SDK, und SDK wie Core wären an eine Version von zod gebunden. Der Core liest das Ergebnis von `validate` wie jeden fremden Wert und engt es ein.

## Consequences

- Ein Plugin, das Operationen anbietet, bringt seinen Validator als eigene Abhängigkeit mit; das Referenz-Plugin nutzt zod in derselben Version wie der Core.
- Die Ausgabe einer Operation ist, was ihr Ausgabe-Schema aus dem Rückgabewert des Use Cases macht; zod-Objekte lassen dabei unbekannte Felder weg. Das Schema ist damit die explizite Abbildung der Ausgabe.

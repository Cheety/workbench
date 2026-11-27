# Die HTTP-API ruft jede Operation per POST auf einem Workspace auf, ihr Vertrag kommt aus Standard JSON Schema

Jede Operation hat den Pfad `POST /api/workspaces/{workspace}/operations/{operation}`; der Body ist die Eingabe als JSON, die Antwort 200 die Ausgabe, jedes Scheitern Problem Details. Auch eine Query geht per POST: Ihre Eingabe ist ein beliebiges JSON-Objekt mit Typen (etwa `limit` als Zahl), das sich nicht verlustfrei in einen Query-String abbilden lässt. Erwogen wurde, Queries per GET mit der Eingabe als Query-Parametern anzubieten; dann bräuchte jede Operation eine zweite Abbildung ihres Schemas auf Strings. Erwogen wurde auch ein einziger Endpunkt mit dem Namen der Operation im Body (RPC); dann beschriebe der OpenAPI-Vertrag nur einen Pfad mit einer Union aller Eingaben, und Logs und Proxies sähen nicht, welche Operation lief.

Den Vertrag erzeugt `bun run openapi` aus den Operationen aller Plugin-Pakete nach `docs/openapi.json` (OpenAPI 3.1). Die Schemas kommen aus der Erweiterung `~standard.jsonSchema` von [Standard JSON Schema](https://standardschema.dev), die zod 4 erfüllt; der Core bleibt damit wie in ADR-0010 frei von zod-Typen und braucht keine neue Abhängigkeit. Ein Schema ohne diese Erweiterung erscheint als `{}`, beliebiges JSON. Erwogen wurde, den Vertrag zur Laufzeit unter einem Pfad auszuliefern; der Vertrag im Repo zeigt aber in jeder Pull-Request, wie sich die API ändert, und ein Test hält ihn mit den Operationen gleich.

## Consequences

- Der Vertrag beschreibt alle Plugin-Pakete des Repos, nicht die in einer Instanz aktivierten; eine Instanz bietet nur die Operationen ihrer aktiven Plugins an.
- Ein Aufruf vor dem Ende des Starts erhält 503 (`instance_not_ready`), weil die Operationen der Plugins erst dann feststehen.

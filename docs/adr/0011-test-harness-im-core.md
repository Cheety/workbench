# Das Test-Harness für Operationen liegt im Core als `@workbench/core/testing`

Die Spec nennt das Test-Harness „Akteur ruft Operation auf“ als Teil des SDK. Das Harness muss aber die echte Pipeline, den Kernel und den Migrations-Runner des Cores benutzen, gegen ein echtes Postgres; ein Nachbau im SDK wäre der In-Memory-Core, den die Spec ausdrücklich verwirft. Läge das Harness im SDK, hinge das SDK vom Core ab und der Core vom SDK, ein Zyklus, den ADR-0007 gerade vermeidet. Das Harness liegt deshalb im Core unter `src/testing/` und wird als Subpath-Export `@workbench/core/testing` veröffentlicht; ein Plugin-Paket nennt `@workbench/core` nur als `devDependency` und importiert es nur in Tests.

Erwogen wurde ein eigenes Paket `@workbench/testing`, das Core und SDK zusammenführt. Es enthielte nur Weiterleitungen auf Interna des Cores und wäre ein weiteres Paket ohne eigene Fachsprache. Erwogen wurde auch, das Harness als Re-Export im SDK anzubieten und den Core zur Laufzeit dynamisch zu laden; dann verdeckte ein berechneter Import die Abhängigkeit vor den Architekturtests (ADR-0009).

## Consequences

- Plugin-Pakete hängen in ihren Tests vom Core ab, zur Laufzeit weiterhin nur vom SDK. Ein Architekturtest, der Importe von `@workbench/core` außerhalb von Tests eines Plugins ablehnt, fehlt noch.
- Das Harness legt je Aufruf von `startOperationHarness` eine eigene Datenbank an, wie `createFreshDatabase()` es für die Tests des Cores tut, und liest dafür `TEST_DATABASE_URL`.

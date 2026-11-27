# Das Audit entsteht in der Transaktion der Mutation und wird über eine Operation des Cores gelesen

Die Pipeline schreibt für jede Mutation, deren Ausgabe das Ausgabe-Schema erfüllt, einen Audit-Eintrag nach `core.audit_entries`, in derselben Transaktion wie die Mutation: ID, Zeitpunkt, Art und ID des Akteurs, ID des API-Tokens, Name der Operation, Workspace als Ziel und Ergebnis. Ein Plugin tut dafür nichts. Mutation und Eintrag gibt es nur zusammen: Ein Rollback nimmt den Eintrag mit, und ein Eintrag, der sich nicht schreiben lässt, rollt die Mutation zurück.

Das Ergebnis ist deshalb bisher immer `succeeded`. Erwogen wurde, auch gescheiterte Mutationen zu auditieren, in einer zweiten Transaktion nach dem Rollback. Das widerspräche dem Zweck der gemeinsamen Transaktion, brächte einen eigenen Fehlerpfad (was gilt, wenn die zweite Transaktion scheitert?) und wenig Wert: Eine gescheiterte Mutation hat nichts geändert und steht mit Korrelations-ID im Log. Verweigerte Zugriffe und Anmeldungen kommen mit Rechteprüfung und Login als weitere Ergebnisse dazu, additiv per neuer Migration.

Der Aufruf nennt das API-Token ausdrücklich: `authenticateToken` liefert neben dem Akteur die ID des Tokens, und die Pipeline verlangt sie als Pflichtangabe, die auch `null` sein darf (ein Aufruf über das Test-Harness, später eine Session). Erwogen wurde ein optionales Feld; dann schriebe ein Aufrufer, der das Token vergisst, still einen Eintrag ohne Token. Der Eintrag nennt nur IDs, nie den Klartext oder den Hash eines Tokens und nie die Eingabe der Mutation, die Secrets enthalten kann.

`core.audit_entries` verweist per Fremdschlüssel auf `core.workspaces` und `core.api_tokens`, aber nicht auf den Akteur: Er ist ein Nutzer oder ein Service-Account, und die Tabelle der Nutzer gibt es noch nicht. Seine ID steht deshalb als Text neben seiner Art. Der Zeitpunkt ist `timestamptz(3)`, damit er die Uhr der Instanz ohne Rundung wiedergibt und sich als Sortierschlüssel verlustfrei durch JSON reichen lässt.

Gelesen wird das Audit über `core.listAuditEntries`, eine Query des Cores, die wie jede Operation eines Plugins in der Registry steht, durch die Pipeline läuft und per HTTP erreichbar ist. Erwogen wurde ein eigener HTTP-Endpunkt neben den Operationen; er bräuchte eine zweite Authentifizierung, Fehlerabbildung und Beschreibung und fehlte in MCP und CLI. Damit `core.<name>` eindeutig dem Core gehört, hat eine registrierte Operation einen Besitzer (Core oder Plugin), aus dem die Pipeline `search_path` und Präfix des Fehlercodes ableitet.

Die ID eines Audit-Eintrags kommt aus einer eigenen Quelle der Pipeline (`newAuditEntryId`), nicht aus `newId()` der Operation. Erwogen wurde, beide aus einer Quelle zu ziehen; dann verschöbe jede Mutation im Test-Harness die IDs der folgenden Operationen, und ein Test, der seine IDs vorgibt, hinge davon ab, wie viele der Core für sich verbraucht. Erwogen wurde auch eine von Postgres erzeugte ID; dann ließe sich die Reihenfolge von Einträgen desselben Zeitpunkts im Test nicht vorgeben.

## Consequences

- Das Recht `core.audit.read` ist für den Instanz-Admin gedacht und wird keiner Rolle zugeordnet. Solange Rechte nicht durchgesetzt werden, darf jeder Akteur mit gültigem Token das Audit jedes Workspaces lesen; mit der Rechteprüfung ist die Operation von selbst für alle anderen gesperrt.
- Ein API-Token oder Workspace, auf den ein Audit-Eintrag verweist, lässt sich nicht löschen. Widerruf und Archivierung müssen die Zeile behalten.
- Das Audit wächst mit jeder Mutation und hat noch keine Aufbewahrungsfrist; sie folgt mit der Entscheidung, wie lange ein Mandant seine Nachweise braucht.
- Ein Plugin mit Datenbankzugriff schreibt im selben Transaktionsobjekt wie der Core. Dass es `core.audit_entries` nicht anfasst, sichern wie bei jedem fremden Schema ADR-0003 und die Review, nicht Postgres.

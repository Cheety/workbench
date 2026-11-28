# Der Instanz-Admin steht in der Instanz-Config, eigene Rollen stehen in Tabellen, Startrollen bleiben bei der Deklaration

Workspaces anlegen, Mitgliedschaften vergeben und eigene Rollen definieren (#16) braucht einen Instanz-Admin, den es bisher nicht gab, und Operationen, die nicht auf einem Workspace laufen.

## Instanz-Admin

Instanz-Admin ist jeder Service-Account, dessen ID die Umgebungsvariable `INSTANCE_ADMIN_SERVICE_ACCOUNTS` nennt (durch Komma getrennte UUIDs, ohne Angabe niemand). `config.ts` prüft sie beim Start; die Pipeline fragt bei jedem Aufruf nur diese Liste. Nutzer mit Login gibt es noch nicht, deshalb kann bisher nur ein Service-Account Instanz-Admin sein.

Erwogen wurden:

- eine Tabelle `core.instance_admins`, gepflegt über eine Option von `create-service-account`. Sie wirkt ohne Neustart, braucht aber eine Migration, deren Daten bleiben, wenn die Entscheidung sich mit dem lokalen Login (Story 7) ändert, und ein eigenes Werkzeug, um einen Admin wieder zu entziehen.
- eine Spalte an `core.service_accounts`. Sie bindet den Instanz-Admin an Service-Accounts, obwohl er laut Glossar ein Nutzer sein soll.
- den ersten Service-Account automatisch zum Admin zu machen. Das hängt an der Reihenfolge des Anlegens und ist im Nachhinein nicht zu erkennen.

Die Instanz-Config ist die am leichtesten umkehrbare Option: Sie hinterlässt keine Daten, ein Betreiber sieht und ändert sie an einer Stelle, und eine spätere Speicherung in der Datenbank ersetzt nur die Quelle der Liste, nicht die Prüfung in der Pipeline. Der Preis: Ein neuer Admin wirkt erst nach einem Neustart, und seine ID muss bekannt sein, bevor er Admin wird (erst `create-service-account`, dann die Variable setzen).

## Operationen auf der Instanz

Eine Operation läuft entweder auf einem Workspace oder auf der Instanz. Eine Operation auf der Instanz hat keinen Workspace, keinen Zugriff auf `ctx.auth`, `publish` und `enqueue` und erscheint per HTTP unter `POST /api/operations/{operation}`, als MCP-Tool ohne Argument `workspace` und im CLI ohne `--workspace`. Erwogen wurde, `createWorkspace` und `listWorkspaces` auf einem beliebigen Workspace aufzurufen; dann bräuchte das Anlegen des ersten Workspace schon einen, und die Liste der Workspaces hinge an einem davon.

Nur der Core deklariert Operationen auf der Instanz. Das SDK bleibt unverändert: Ein Recht eines Plugins steht Rollen zu, und eine Rolle gibt es nur über eine Mitgliedschaft in einem Workspace, also gäbe es für eine Operation eines Plugins auf der Instanz niemanden, dem ihr Recht zusteht. Das lässt sich additiv öffnen, wenn ein Plugin sie braucht.

Jede Operation verweist weiter auf genau ein Recht. Wem es zusteht, legt der Core fest: einer Rolle über die Mitgliedschaft (alle Operationen der Plugins und `core.listAuditEntries`), dem Instanz-Admin (`core.createWorkspace`, `core.defineRole`, `core.grantMembership`, `core.revokeMembership`, `core.listInstanceAuditEntries`) oder jedem Akteur (`core.listWorkspaces`, das nur Workspaces mit Mitgliedschaft nennt). Ein Recht des Instanz-Admins lässt sich keiner Rolle geben. `grantMembership` und `revokeMembership` laufen auf dem Workspace der Mitgliedschaft, damit Audit und Idempotency-Key ihn nennen und dessen Owner die Änderung in `core.listAuditEntries` sehen. Ein Instanz-Admin braucht dafür keine Mitgliedschaft; ein anderer Akteur erhält ohne Mitgliedschaft `workspace_not_found` wie bisher, mit Mitgliedschaft `not_instance_admin`, damit er nichts über fremde Workspaces erfährt. Der Instanz-Admin erhält dadurch keinen Zugriff auf die Inhalte eines Workspace; dafür braucht auch er eine Mitgliedschaft.

## Rollen und ihre Rechte

`core.roles` hält die Rollen, die drei Startrollen als feste Zeilen, `core.role_rights` die Rechte eigener Rollen. `core.memberships.role` verweist per Fremdschlüssel auf `core.roles` statt einer `CHECK`-Bedingung (ADR-0021). Die Startrollen behalten ihre Rechte aus den `defaultRoles` der Deklarationen und bekommen keine Zeilen in `core.role_rights` (eine `CHECK`-Bedingung verbietet sie); `core.defineRole` lehnt ihre Namen ab (`core.start_role_not_definable`).

ADR-0021 ließ offen, ob die Default-Zuordnung beim ersten Laden eines Rechts in Tabellen geschrieben wird. Erwogen wurde das wieder: Der Instanz-Admin könnte dann auch Startrollen ändern, und die Pipeline fragte nur Tabellen. Dafür bräuchte der Start einen Schreibvorgang mit eigener Fehlerbehandlung, ein Verzeichnis der schon gesehenen Rechte und eine Regel, was ein Update tut, das `defaultRoles` eines Rechts ändert, dessen Zeilen der Admin gepflegt hat; jede Regel überrascht entweder das Plugin oder den Admin. Erwogen wurde auch, eigene Rollen nur im Speicher zu halten, aus der Instanz-Config; dann wären sie keine Operation und weder per HTTP, MCP und CLI erreichbar noch auditiert. Gewählt ist der kleinste Schritt, der eigene Rollen ermöglicht: Startrollen aus der Deklaration, eigene Rollen aus den Tabellen. Startrollen in Tabellen zu übernehmen bleibt möglich, additiv per Migration.

`core.defineRole` legt eine Rolle an oder ersetzt ihre Rechte vollständig. Ein Recht, das keine Operation des Cores oder eines aktiven Plugins über eine Rolle vergibt, lehnt sie mit `core.unknown_right` ab; erwogen wurde, jedes wohlgeformte Recht anzunehmen, damit ein Admin Rollen für ein noch nicht aktiviertes Plugin vorbereiten kann, aber dann bliebe ein Tippfehler still wirkungslos.

Eine Mutation liest Mitgliedschaft und Rolle mit `FOR SHARE`, `defineRole` sperrt die Zeile der Rolle mit `FOR UPDATE`, bevor sie die Rechte ersetzt; so wartet eine Neudefinition auf laufende Mutationen ihrer Mitglieder wie ein Entzug der Mitgliedschaft (ADR-0021). Die Rechte einer eigenen Rolle liest die Pipeline erst nach der Sperre, in einer eigenen Anweisung, damit sie die Definition sieht, auf deren Ende sie gewartet hat.

## Audit

Jede gelungene Mutation auf der Instanz hinterlässt einen Audit-Eintrag ohne Workspace (`workspace` `null`), außer `core.createWorkspace`: Sein Eintrag nennt den angelegten Workspace, damit das Audit der Instanz zeigt, welcher Workspace entstand, und dessen Owner die Anlage in `core.listAuditEntries` sehen. Ein verweigerter Aufruf eines Nicht-Admins einen Eintrag `denied` mit `reason` `not_instance_admin`. `core.audit_entries.workspace_id` und `core.idempotency_keys.workspace_id` dürfen dafür leer sein. Der Teilindex, der Verweigerungen auf eine je Minute begrenzt, behandelt einen leeren Workspace mit `NULLS NOT DISTINCT` als gleich, sonst wüchse das Audit mit jedem Versuch eines Nicht-Admins. Gelesen wird das ganze Audit über `core.listInstanceAuditEntries`, nur vom Instanz-Admin; `core.listAuditEntries` bleibt bei den Ownern des Workspace.

## Consequences

- `core.audit.read` bleibt bei der Startrolle `owner` (ADR-0021); der Instanz-Admin liest das Audit über `core.listInstanceAuditEntries`, das ADR-0014 noch nicht kannte.
- Ein Audit-Eintrag von `core.grantMembership` und `core.revokeMembership` nennt das Mitglied und die vergebene oder entzogene Rolle, einer von `core.defineRole` die Rolle und die Rechte, die die Definition ihr gab, in eigenen Spalten von `core.audit_entries`, die leer sein dürfen. Ohne die Rechte sähe der Instanz-Admin im Audit nur, dass eine Rolle neu definiert wurde, nicht, was sie danach erlaubt. Die Ausgabe nennt `rights` nur in Einträgen von `core.defineRole`, damit die übrigen Einträge ihre Form behalten. Sonst nennt er weiterhin nichts aus der Eingabe; ADR-0014 gilt für alle anderen Mutationen unverändert. Erwogen wurde, das Mitglied nur im Log zu nennen; dann sähe ein Owner im Audit seines Workspace nicht, wem eine Mitgliedschaft gegeben oder entzogen wurde. Die Rolle eines Entzugs kommt aus der gelöschten Zeile, deshalb nennt auch die Ausgabe von `core.revokeMembership` sie.
- `grantMembership` prüft nicht, ob der Akteur existiert: Für Nutzer gibt es noch keine Tabelle, und `core.memberships` hat keinen Fremdschlüssel auf den Akteur.
- Eine Rolle lässt sich nicht löschen, und ein Workspace ist nicht umzubenennen oder zu löschen; das folgt mit eigenen Stories.
- Die Liste der Workspaces eines Instanz-Admins enthält wie für jeden Akteur nur Workspaces mit Mitgliedschaft; eine Übersicht aller Workspaces für den Admin fehlt noch.

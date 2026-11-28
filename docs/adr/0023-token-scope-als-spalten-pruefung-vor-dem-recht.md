# Der Token-Scope steht in Spalten von `core.api_tokens`, die Pipeline prüft ihn vor dem Recht

ADR-0012 ließ Scope und Widerruf eines API-Tokens offen (#17). Ein Akteur legt seine Tokens jetzt selbst über `core.createApiToken` an, sieht sie über `core.listApiTokens` und widerruft sie über `core.revokeApiToken`.

## Speicherung

`core.api_tokens` bekommt die Spalten `operations` und `workspaces` (`jsonb`, eine Liste von 1 bis 100 Strings oder `NULL` für „keine Einschränkung“; eine `CHECK`-Bedingung verlangt die Form, damit eine fehlerhafte Zeile die Prüfung des Tokens nicht scheitern lässt), `revoked_at` und `created_by_api_token_id`. Erwogen wurden eigene Tabellen je Token und Operation oder Workspace. Sie erlaubten einen Fremdschlüssel auf `core.workspaces`, bräuchten aber eine eigene Spalte, die „keine Einschränkung“ von „nichts“ unterscheidet, und zwei weitere Abfragen bei jeder Anfrage. Ein Fremdschlüssel verriete außerdem beim Anlegen, ob ein Workspace existiert. Der Scope wird nur als Ganzes gelesen und nie geändert; Spalten am Token reichen und die Prüfung beim Aufruf liest eine Zeile. `jsonb` folgt `core.audit_entries.rights`.

## Prüfung

Die HTTP-API liest den Scope beim Prüfen des Tokens und reicht ihn als Teil des Aufrufs an die Pipeline. Die Pipeline prüft ihn in der Transaktion des Aufrufs, nachdem sie weiß, dass der Workspace existiert, und vor Mitgliedschaft und Recht. Weil der Scope die Rechte des Akteurs nur einschränkt und danach Mitgliedschaft und Recht wie ohne Token gelten, hat ein Token nie mehr Rechte als sein Akteur.

- Ein Workspace außerhalb des Scopes scheitert wie einer ohne Mitgliedschaft mit `workspace_not_found`, damit ein Token nichts über Workspaces erfährt, die es nicht nutzen darf. Erwogen wurde ein eigener Code mit 403; dann unterschiede ein auf einen Workspace beschränktes Token existierende von fehlenden Workspaces. Der Audit-Eintrag nennt den Grund `workspace_outside_token_scope`, abweichend von ADR-0021, wonach der Grund der Code des Aufrufers ist; sonst sähe ein Owner eine Verweigerung `workspace_not_found` eines Mitglieds und könnte sie nicht erklären.
- Eine Operation außerhalb des Scopes scheitert mit `operation_outside_token_scope` (403), erst nach der Mitgliedschaft, damit ein Nicht-Mitglied weiter nur `workspace_not_found` sieht. Die Namen der Operationen sind ohnehin öffentlich (`GET /api/operations`).
- Ein Token mit `workspaces` ruft keine Operation auf der Instanz auf (`instance_outside_token_scope`). Erwogen wurde, den Workspace-Scope für Operationen auf der Instanz nicht zu beachten; dann nennte `core.listWorkspaces` einem auf einen Workspace beschränkten Token alle Workspaces seines Akteurs, und ein solches Token könnte ein unbeschränktes anlegen.
- Ein Token mit `operations`, das `core.createApiToken` aufrufen darf, legt nur Tokens an, deren Operationen in seinen liegen und die nicht später ablaufen als es selbst (`core.token_scope_exceeded`); sonst könnte es sich selbst erweitern oder seinen Widerruf überdauern.

## Widerruf

Widerrufen ist ein Token, sobald `revoked_at` gesetzt ist; die Prüfung des Tokens lehnt es bei jedem folgenden Aufruf ab (`revoked_token`). Erwogen wurde, das Token in der Transaktion jedes Aufrufs mit `FOR SHARE` zu lesen wie die Mitgliedschaft (ADR-0021); dann wartete ein Widerruf auf laufende Aufrufe. Die Spec verlangt nur, dass der nächste Aufruf scheitert, und die zusätzliche Sperre läge auf jedem Aufruf. Ein Aufruf, der vor dem Widerruf angenommen war, läuft deshalb zu Ende.

Die Ausnahme ist `core.createApiToken`, weil es ein neues Zugangsmittel erzeugt: Es liest das Token des Aufrufs in seiner Transaktion mit `FOR SHARE` und prüft, dass es weder abgelaufen noch es oder eines seiner Vorgänger widerrufen ist (`core.calling_token_invalid`). Ein Widerruf, der danach kommt, wartet auf das Ende des Anlegens.

`created_by_api_token_id` nennt das Token, mit dem ein Token angelegt wurde. Ein Widerruf setzt `revoked_at` in derselben Anweisung für das Token und alle Tokens, die von ihm abstammen, damit `core.listApiTokens` sie als widerrufen zeigt. Zusätzlich lehnt die Prüfung eines Tokens es ab, wenn einer seiner Vorgänger widerrufen ist: Ein Token, das ein nebenläufiges Anlegen erst nach Beginn der Anweisung des Widerrufs festschrieb, sieht diese Anweisung nicht, ist über seinen Vorgänger aber trotzdem wirkungslos. Erwogen wurde, nur den Vorgänger beim Prüfen zu fragen; dann nennte die Liste ein wirkungsloses Token als gültig. Die Prüfung der Vorgänger kostet nur für ein Token, das mit einem Token angelegt wurde, eine zweite Abfrage.

Ein Akteur widerruft und sieht mit jedem seiner Tokens, das die Operationen dieses Abschnitts aufrufen darf, alle seine Tokens, auch eines mit weiterem Scope als das aufrufende. Das ist gewollt: Ein Token handelt für seinen Akteur, und widerrufen schränkt nur ein; ein Token, das das nicht darf, schließt die Operationen über `operations` aus.

## Idempotency-Key

Die Antwort von `core.createApiToken` enthält das Token im Klartext. Mit einem Idempotency-Key hielte `core.idempotency_keys` sie mindestens 24 Stunden fest, entgegen ADR-0012, wonach die Instanz nur den Hash speichert. Die Operation beachtet deshalb keinen Key, wie eine Query; OpenAPI und MCP bieten ihn nicht an. Erwogen wurde, einen Key mit eigenem Code abzulehnen; das bräche Clients, die jeder Mutation einen Key mitgeben. Eine Wiederholung legt ein zweites Token an, das ungenutzt abläuft oder widerrufen wird.

## Consequences

- Bis es Nutzer mit Login gibt, hält nur ein Service-Account Tokens (`core.api_tokens.service_account_id`); ein Nutzer erhält `core.not_a_service_account`. Tokens für Nutzer verlangen eine neue Migration, die den Akteur nach Art und ID nennt.
- Das Token aus `create-service-account` hat keinen Scope.
- Audit-Einträge von Anlegen und Widerruf nennen das Token des Aufrufs, nicht das angelegte oder widerrufene.
- Abgelaufene und widerrufene Tokens bleiben in `core.api_tokens`; ein Löschjob fehlt noch.

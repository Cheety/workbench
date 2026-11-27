# Workbench Core

Die Workbench ist eine selbst gehostete, erweiterbare Arbeitsoberfläche. Der Core lädt Plugins und stellt ihnen Infrastruktur bereit; jede fachliche Funktion kommt als Plugin.

## Betrieb und Abgrenzung

**Mandant**:
Eine organisatorische Einheit mit strikt getrennten Daten, z. B. „privat“ oder „Firma“. Jeder Mandant hat seinen eigenen Linux-User, seine eigene Postgres-Datenbank und seine eigene Subdomain.
_Avoid_: Tenant, Organisation, Account

**Instanz**:
Die laufende Installation der Workbench für genau einen Mandanten; Mandant und Instanz stehen immer 1:1.
_Avoid_: Server, Deployment, Umgebung

**Workspace**:
Ein fachlicher Container innerhalb einer Instanz, dem Objekte, Einstellungen und Layouts zugeordnet sind.
_Avoid_: Projekt, Bereich, Space

## Erweiterung

**Plugin**:
Ein Paket, das der Workbench Funktion hinzufügt; auch Basis-Funktionen wie das Default-Layout sind Plugins.
_Avoid_: Modul, Extension, Add-on

**Plugin-Paket**:
Das Paket im Repository, das ein Plugin samt Manifest, Server- und Client-Teil, Migrationen und Contract enthält.
_Avoid_: Workspace-Paket

**Kernel**:
Der Teil des Core, der die Plugin-Pakete entdeckt, Manifeste prüft, `requires` auflöst, die Schemas der Plugins mit der Capability `database` migriert und die in der Instanz-Config aktivierten Plugins aktiviert und beim Shutdown deaktiviert.
_Avoid_: Plugin-Manager, Loader, Plugin-Host

**Manifest**:
Die Selbstbeschreibung eines Plugins, die der Kernel vor der Aktivierung prüft: Name, vorausgesetzte Plugins (`requires`) und Capabilities.
_Avoid_: Plugin-Config, Descriptor

**Instanz-Config**:
Die Konfiguration einer Instanz aus der Umgebung; sie bestimmt unter anderem, welche Plugins die Instanz aktiviert.
_Avoid_: Settings, Einstellungen (das sind die Ebenen Instanz, Workspace, Nutzer)

**Ladefehler**:
Der dem Betreiber gemeldete Grund, aus dem ein in der Instanz-Config aktiviertes Plugin nicht geladen wurde.
_Avoid_: Plugin-Fehler, Startfehler

**Capability**:
Ein technisches Vermögen, das ein Plugin im Manifest deklariert und nur dann erhält, z. B. Datenbankzugriff, ein Event-Abo oder ein ausführbares Binary.
_Avoid_: Permission, Berechtigung, Recht

**Override**:
Die vom Instanz-Admin freigegebene Ersetzung einer View oder eines Commands eines Plugins durch ein anderes Plugin.
_Avoid_: Patch, Replacement

**Contract**:
Der öffentliche Teil eines Plugins (Service-Typen, Event-Definitionen, Schemas, Werte-Typen), den andere Plugins als einziges importieren dürfen.
_Avoid_: Interface-Paket, API-Typen

**Event**:
Ein Fakt in Vergangenheitsform, den ein Plugin aus einer Mutation publiziert, z. B. `board.LabelRenamed`; unveränderlich, mit ID, Zeitpunkt, Version, Workspace und IDs statt Objekten.
_Avoid_: Nachricht, Message, Signal

**Event-Abo**:
Die im Manifest als Capability deklarierte und in der Plugin-Definition registrierte Absicht eines Plugins, ein bestimmtes Event zu erhalten.
_Avoid_: Subscription (außer als Bezeichner im Code), Listener, Hook

**Event-Handler**:
Die Funktion eines Plugins, die der Core für ein Event-Abo mit jedem Event aufruft.
_Avoid_: Listener, Callback, Consumer

**Outbox**:
Die Tabellen des Cores, in die eine Mutation ihre Events in ihrer eigenen Transaktion schreibt und aus denen der Core sie nach dem Festschreiben zustellt.
_Avoid_: Queue, Event-Bus, Event-Store

**Zustellung**:
Der Aufruf des Event-Handlers genau eines abonnierenden Plugins mit genau einem Event; sie gelingt mindestens einmal.
_Avoid_: Dispatch, Auslieferung, Benachrichtigung

## Inhalte

**Objekt**:
Ein fachliches Ding eines Plugins, das im Objekt-Register angemeldet ist und genau einem Plugin und genau einem Workspace gehört.
_Avoid_: Entity, Item, Ressource

**Link**:
Eine gerichtete, typisierte Beziehung zwischen zwei Objekten desselben Workspaces.
_Avoid_: Relation, Verknüpfung, Referenz

**Link-Typ**:
Die von einem Plugin deklarierte Bedeutung eines Links, z. B. `blocks` oder `derived-from`.
_Avoid_: Relationstyp, Kante

**Layout**:
Die Anordnung von Views in Regionen, die ein Nutzer pro Workspace für sich hat.
_Avoid_: Ansicht, Perspektive

**Workspace-Layout**:
Ein in einem Workspace veröffentlichtes Layout, das andere Mitglieder als Kopie übernehmen.
_Avoid_: Geteiltes Layout, Layout-Vorlage

## Interaktion

**Operation**:
Eine fachliche Aktion auf dem Server mit Eingabe-Schema, Autorisierung und Ergebnis; jede Operation ist über UI, HTTP-API, MCP und CLI erreichbar.
_Avoid_: Action, Endpoint, Use Case (in der Plugin-Sprache)

**Command**:
Ein Eintrag in Command-Palette, Menü oder Tastenkürzel im Client, der eine Operation aufruft oder eine reine Client-Aktion ausführt.
_Avoid_: Befehl, Action

## Zugriff

**Akteur**:
Wer eine Operation auslöst: ein Nutzer oder ein Service-Account.
_Avoid_: Principal, Subjekt, Caller

**Nutzer**:
Ein Mensch mit Login in einer Instanz; eine Instanz hat mehrere Nutzer.
_Avoid_: Account, Member

**Service-Account**:
Ein Akteur ohne Login, z. B. ein Agent, der nur über API-Tokens handelt.
_Avoid_: Bot, Technischer Nutzer, Agent-User

**Plugin-Service-Account**:
Der Service-Account, den jedes Plugin automatisch erhält und unter dem seine Jobs und Event-Handler ohne auslösenden Akteur laufen.
_Avoid_: System, System-User

**API-Token**:
Ein Zugangsschlüssel, der genau einem Akteur gehört und dessen Rechte auf bestimmte Operationen und Workspaces einschränkt, mit Ablaufdatum.
_Avoid_: API-Key, Personal Access Token

**Mitgliedschaft**:
Die Zugehörigkeit eines Akteurs zu einem Workspace mit einer Rolle; ohne Mitgliedschaft ist ein Workspace für den Akteur unsichtbar.
_Avoid_: Zugriff, Freigabe

**Rolle**:
Eine frei definierbare, benannte Zusammenstellung von Rechten, die über eine Mitgliedschaft vergeben wird.
_Avoid_: Gruppe, Berechtigungsstufe

**Recht**:
Eine von einem Plugin deklarierte, benannte Erlaubnis (z. B. `kanban.board.edit`), auf die jede Operation genau einmal verweist.
_Avoid_: Permission, Scope, Privileg

**Instanz-Admin**:
Ein Nutzer, der Plugins, Nutzer und Instanz-Einstellungen verwaltet, unabhängig von Mitgliedschaften.
_Avoid_: Superuser, Root

**Einladung**:
Ein einmaliger, befristeter Link, über den ein neuer Nutzer mit einer festgelegten Mitgliedschaft in die Instanz kommt.
_Avoid_: Invite-Code, Registrierung

**Audit**:
Der Nachweis der Instanz, welcher Akteur mit welchem API-Token welche Operation auf welchem Workspace ausgeführt hat.
_Avoid_: Audit-Log, Protokoll, History

**Audit-Eintrag**:
Der Nachweis genau eines Vorgangs im Audit, z. B. einer gelungenen Mutation: Akteur, API-Token, Operation, Ziel, Zeitpunkt und Ergebnis.
_Avoid_: Log-Eintrag (das ist eine Zeile im Log für den Betreiber), Audit-Event, Audit-Record

## Zusammenarbeit

**Presence**:
Die flüchtige Anzeige, welcher Akteur gerade wo ist, z. B. Cursor oder Auswahl in einer View.
_Avoid_: Awareness, Online-Status

**Kollaborations-Dokument**:
Der gemeinsam und gleichzeitig bearbeitbare Zustand eines Objekts, z. B. der Inhalt eines Whiteboards.
_Avoid_: Shared Doc, Live-Dokument

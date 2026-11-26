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

**Contract**:
Der öffentliche Teil eines Plugins (Service-Typen, Event-Definitionen, Schemas, Werte-Typen), den andere Plugins als einziges importieren dürfen.
_Avoid_: Interface-Paket, API-Typen

## Interaktion

**Operation**:
Eine fachliche Aktion auf dem Server mit Eingabe-Schema, Autorisierung und Ergebnis; jede Operation ist über UI, HTTP-API, MCP und CLI erreichbar.
_Avoid_: Action, Endpoint, Use Case (in der Plugin-Sprache)

**Command**:
Ein Eintrag in Command-Palette, Menü oder Tastenkürzel im Client, der eine Operation aufruft oder eine reine Client-Aktion ausführt.
_Avoid_: Befehl, Action

**Nutzer**:
Ein Mensch mit Login in einer Instanz; eine Instanz hat mehrere Nutzer.
_Avoid_: Account, Member

# Echtzeit-Zusammenarbeit als Core-Dienst auf Basis von Yjs, ersetzbar je Plugin

Mehrere Cursor und gleichzeitiges Bearbeiten sollen in v1 möglich sein, ohne dass jedes Plugin eine eigene Sync-Lösung baut. Der Core liefert deshalb `ctx.collab`: Presence und Kollaborations-Dokumente auf Basis von Yjs. Jedes Kollaborations-Dokument ist an ein Objekt gebunden und erbt dessen Workspace-Rechte. Die Yjs-Updates speichert der Core. Das Plugin erhält Events und schreibt daraus seine fachliche Projektion ins eigene Schema. Das ist eine bewusste Ausnahme von ADR-0003: Der Core besitzt das CRDT-Format, das Plugin die Fachdaten. Ein Plugin darf stattdessen eine eigene Sync-Lösung einbauen, z. B. für spezielle Datenstrukturen. Erwogen wurden reine Plugin-Lösungen (doppelter Aufwand, uneinheitliche Presence) und nur Presence im Core.

## Consequences

- Yjs wird eine Core-Abhängigkeit und ist im Bericht bzw. in der Abhängigkeitsfreigabe aufzuführen.

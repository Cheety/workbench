# Workspace ist das einzige fachliche Konzept im Core

Eigentlich gilt „leerer Core, alles Plugin“. Der Workspace gehört trotzdem dem Core (`core.workspaces`), weil Einstellungen, Layouts, das Objekt-Register und Berechtigungen einen gemeinsamen Scope brauchen, bevor überhaupt ein Plugin geladen ist. Das Basis-Plugin liefert nur die Oberfläche zur Verwaltung von Workspaces, nicht das Konzept selbst. Wer den Workspace in ein Plugin verschieben will, müsste alle Core-Scopes von diesem Plugin abhängig machen.

# Ein API-Token wird als SHA-256-Hash gespeichert, nicht mit Argon2id

Ein API-Token besteht aus dem Präfix `wbt_` und 32 Bytes aus `crypto.getRandomValues`, Base64url-kodiert. Die Tabelle `core.api_tokens` speichert nur den SHA-256-Hash in Hexadezimal (`UNIQUE`); den Klartext gibt das Kommando `create-service-account` genau einmal aus. Beim Aufruf hasht der Core das Bearer-Token und sucht den Hash per Index.

Erwogen wurde Argon2id, das die Spec für Passwörter vorsieht und Bun als `Bun.password` mitbringt. Argon2id verlangsamt das Durchprobieren schwacher, von Menschen gewählter Geheimnisse; ein Token mit 256 Bit Zufall lässt sich auch ohne diese Bremse nicht durchprobieren. Ein gesalzener Hash ließe sich außerdem nicht per Index suchen: Jeder Aufruf müsste einen Token-Präfix als Schlüssel mitbringen und dann eine bewusst teure Prüfung zahlen, bei jeder Anfrage der HTTP-API. Erwogen wurde auch ein HMAC mit einem Secret der Instanz; er schützte nur dann zusätzlich, wenn jemand die Datenbank ohne das Secret liest, und brächte ein weiteres Secret mit Rotation, ohne dass die Spec es verlangt.

## Consequences

- Wer die Tabelle liest, erhält kein nutzbares Token; ein Token lässt sich nur neu ausgeben, nie wieder anzeigen.
- Das Präfix `wbt_` macht ein Token für Secret-Scanner erkennbar.
- Ein Token gilt bis `expires_at` (ausschließlich); Widerruf und Scope folgen mit Identität und Zugriff.

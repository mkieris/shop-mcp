# Team-Setup: Shopware Admin MCP

**Wichtig: Der Test läuft auf STAGING — alle CMS-/Theme-/Produkt-Änderungen
sind sofort im (Staging-)Shop sichtbar.**

## Installation (3 Minuten, keine Vorkenntnisse nötig)

Du brauchst nur die **Claude-Desktop-App** — kein Node.js, kein Git.

1. **Datei holen**: `shopware-admin-mcp.mcpb` vom SharePoint herunterladen
   (Link bekommst du von Martin).
2. **Doppelklick** auf die Datei — die Claude-App öffnet sich und zeigt
   den Installations-Dialog. Auf „Installieren" klicken.
3. **Formular ausfüllen** (Werte bekommst du von Martin):
   - **Shopware-URL (Staging)** — niemals die Live-Shop-URL!
   - **Client-ID** — von deiner persönlichen Integration
   - **Client-Secret** — von deiner persönlichen Integration
   - **Dein Name** — Vor- und Nachname (so erscheinen deine Änderungen im Audit-Log)

Danach Claude-App neu starten — fertig.

> Jedes Teammitglied bekommt eine **eigene** Integration (legt Martin im
> Shopware Admin an). Zugangsdaten niemals untereinander teilen — sonst
> ist im Audit-Log nicht mehr erkennbar, wer was geändert hat.

## Erster Funktionstest

In Claude fragen:

> „Liste die Sales Channels des Shops auf"

Wenn eine Liste mit Namen und Domains zurückkommt, läuft alles. Danach:

> „Zeige die letzten 5 Einträge aus dem Audit-Log"

— dort sollte dein Name als Benutzer erscheinen.

## Updates

Wenn Martin eine neue Version ankündigt: neue `.mcpb`-Datei vom SharePoint
laden, Doppelklick, installieren. Deine eingegebenen Zugangsdaten bleiben
erhalten.

## Spielregeln

- Bei mehr als 10 Objekten gleichzeitig verlangen die Tools
  `confirm_bulk: true` — das ist Absicht (Schutz vor Massen-Änderungen).
- Jede Schreiboperation liefert eine `operationId` zurück. Damit kann eine
  Änderung per „Rolle Operation X zurück" rückgängig gemacht werden.
- **Achtung:** Das Löschen von CMS-Seiten/-Sektionen/-Blöcken ist NICHT
  zurückrollbar. Vor dem Löschen lieber zweimal prüfen.
- Kunden- und Adressdaten sind absichtlich gesperrt (DSGVO) — das ist kein
  Fehler, sondern gewollt.

## Bekannte Einschränkungen (Known Issues)

| Problem | Workaround |
|---|---|
| `product_list` mit `all: true` liefert nur 500 Produkte | Manuell paginieren: `all: false`, `page: 1..N`, `limit: 500` |
| `topLevelOnly` filtert Varianten nicht zuverlässig | Alle laden, lokal nach `parentId === null` filtern |
| `dal_aggregate` kann nicht auf NULL filtern, keine Ranges, kein OR | Separate Aufrufe bzw. `contains`/`not_contains`-Tricks |

---

## Für Entwickler / Maintainer

Quellcode und Versionierung: https://github.com/mkieris/shop-mcp

```powershell
git clone https://github.com/mkieris/shop-mcp.git
cd shop-mcp
npm install          # baut automatisch nach dist/
```

Neues Bundle nach Code-Änderungen bauen:

```powershell
powershell -ExecutionPolicy Bypass -File build-bundle.ps1
```

Erzeugt `shopware-admin-mcp.mcpb` (nur Produktions-Abhängigkeiten, keine
Secrets) — diese Datei auf SharePoint legen.

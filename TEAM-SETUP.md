# Team-Setup: Shopware Admin MCP

Anleitung für Teammitglieder, um den MCP-Server lokal einzurichten.
**Wichtig: Der Test läuft auf STAGING — alle CMS-/Theme-/Produkt-Änderungen sind sofort im Shop sichtbar.**

## 1. Voraussetzungen

- [Node.js 22+](https://nodejs.org) (LTS)
- [Git für Windows](https://git-scm.com/download/win)
- Claude Code (Desktop-App oder CLI)

## 2. Code holen

```bash
git clone https://github.com/mkieris/shop-mcp.git
cd shop-mcp
npm install
```

`npm install` kompiliert den Server automatisch nach `dist/` (prepare-Script).

**Updates später:** `git pull` und danach erneut `npm install`.

## 3. Eigene Shopware-Integration anlegen

Jedes Teammitglied braucht eine **eigene** Integration — darüber werden alle
Änderungen im Audit-Log dir persönlich zugeordnet. Niemals Zugangsdaten teilen!

1. Shopware Admin → Einstellungen → System → **Integrationen** → „Integration anlegen"
2. Name: `mcp_vorname_nachname` (z. B. `mcp_anna_kraus`)
3. Berechtigungen gemäß Tabelle in der [README](README.md#permissions)
4. **Client-ID und Client-Secret kopieren** (Secret wird nur einmal angezeigt!)

## 4. MCP-Server in Claude Code registrieren

```bash
claude mcp add shopware-admin-mcp \
  --env SHOPWARE_API_URL=https://DEINE-STAGING-URL \
  --env SHOPWARE_API_CLIENT_ID=deine-client-id \
  --env SHOPWARE_API_CLIENT_SECRET=dein-client-secret \
  --env MCP_USER_LABEL="Vorname Nachname" \
  -- node C:/pfad/zu/shop-mcp/dist/index.js
```

`MCP_USER_LABEL` ist dein Anzeigename im Audit-Log.

Optional für zentrales Audit-Log (alle Änderungen des Teams in einer Datei):

```
--env AUDIT_DIR=\\netzlaufwerk\mcp-audit
```

## 5. Sicherheitsregeln

- `.env`-Dateien, Client-Secrets und der Ordner `.cache/` (enthält OAuth-Tokens)
  dürfen **niemals** geteilt, hochgeladen oder committet werden.
- Bei mehr als 10 Objekten gleichzeitig verlangen die Tools `confirm_bulk: true` —
  das ist Absicht (Schutz vor Massen-Änderungen).
- Jede Schreiboperation liefert eine `operationId` zurück. Damit kann eine
  Änderung über `audit_rollback` rückgängig gemacht werden.
- **Achtung:** `cms_page_delete` / `cms_section_delete` / `cms_block_delete`
  sind NICHT zurückrollbar. Vor dem Löschen lieber zweimal prüfen.

## 6. Bekannte Einschränkungen (Known Issues)

| Problem | Workaround |
|---|---|
| `product_list` mit `all: true` liefert nur 500 Produkte | Manuell paginieren: `all: false`, `page: 1..N`, `limit: 500` |
| `topLevelOnly` filtert Varianten nicht zuverlässig | Alle laden, lokal nach `parentId === null` filtern |
| `dal_aggregate` kann nicht auf NULL filtern, keine Ranges, kein OR | Separate Aufrufe bzw. `contains`/`not_contains`-Tricks |
| Kunden-/Adressdaten sind absichtlich gesperrt (DSGVO) | Kein Workaround — das ist gewollt |

## 7. Erster Funktionstest

In Claude Code fragen:

> „Liste die Sales Channels des Shops auf"

Wenn eine Liste mit Namen und Domains zurückkommt, läuft alles. Danach:

> „Zeige die letzten 5 Einträge aus dem Audit-Log"

— dort sollte dein `MCP_USER_LABEL` als Benutzer erscheinen.

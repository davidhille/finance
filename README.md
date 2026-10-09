# Haushaltsbuch – Setup

## 1. Supabase
1. Neues Projekt anlegen (eigenes Projekt, nicht das von Nachspielzeit).
2. **SQL Editor** → Inhalt von `schema.sql` einfügen → *Run*.
3. **Authentication → Users → Add user**: deine E-Mail + Passwort anlegen („Auto confirm" anhaken).
4. **Authentication → Sign In / Providers**: *Allow new users to sign up* **ausschalten** – dann kann sich niemand sonst registrieren.
5. **Project Settings → API**: `Project URL` und `anon public` Key kopieren.

## 2. App konfigurieren
In `public/config.js` URL und Anon-Key eintragen. Der Anon-Key ist öffentlich gedacht; geschützt wird über Login + Row Level Security.

## 3. Cloudflare (Worker mit statischen Dateien, keine eigene Domain nötig)
1. dash.cloudflare.com → *Workers & Pages* → *Create* → Repo `davidhille/finance` wählen (darf privat bleiben).
2. Build command leer, Deploy command `npx wrangler deploy` → *Deploy*.
   Die Konfiguration steht in `wrangler.jsonc`, ausgeliefert wird nur der Ordner `public/`.
3. Die App läuft unter `https://finance.davidshille.workers.dev`. Ab dann: `git push` auf `main` = Deploy.
4. Supabase → *Authentication* → *URL Configuration*: diese Adresse als *Site URL* eintragen.

Supabase-Zugangsdaten stehen in `public/config.js`.

## Bedienung
- **Konten**: Auswahl oben rechts (Alle / Gemeinschaft / Privat) filtert alle Ansichten. Konten verwalten unter „Kategorien & Regeln". Kategorien und Regeln gelten für alle Konten.
- **Import**: Konto wählen, dann DKB-CSV (Umsätze → Export CSV) hochladen. Doppelte Buchungen werden erkannt, vorgemerkte übersprungen.
  - Gibt es dieselben Buchungen schon in einem anderen Konto, fragt die App nach (Schutz vor falschem Konto).
  - Gleiches Datum + Betrag wie eine vorhandene Buchung, aber anderer Text → „Mögliche Duplikate" zur Prüfung (Importieren/Verwerfen).
- **Buchungen**: Empfänger direkt im Feld umbenennen, Kategorie per Auswahl setzen.
  - Jede Zuordnung erzeugt eine Regel; gleiche Händler werden sofort mit zugeordnet.
  - *auto* = über Regel zugeordnet, *Vorschlag* = ähnlicher Händler, mit ✓ bestätigen.
  - Umbenennen gilt für alle Buchungen dieses Händlers mit demselben alten Namen.
- **Jahr**: Monats- und Jahressummen je Kategorie, Klick auf Kategorie zeigt Unterkategorien.
- **Jahresvergleich**: Kategorien über alle Jahre, Δ zum Vorjahr.
- **Eigene Regeln** (Kategorien & Regeln → „+ Regel“ oder im Bearbeiten-Dialog „Regel daraus…“): „Wenn Empfänger/Zweck enthält X → Kategorie“, optional nur Ausgaben/Einnahmen, nur ein Konto, neuer Anzeigename. Vorrang vor gelernten Regeln. Empfänger und Verwendungszweck einzeln oder kombiniert (UND). Benötigt `migrations/003_eigene_regeln.sql` und `004_regel_zweck.sql`.
- **Kategorien & Regeln**: Kategorien/Unterkategorien verwalten, gelernte Regeln einsehen/löschen.

# Haushaltsbuch – Setup

## 1. Supabase
1. Neues Projekt anlegen (eigenes Projekt, nicht das von Nachspielzeit).
2. **SQL Editor** → Inhalt von `schema.sql` einfügen → *Run*.
3. **Authentication → Users → Add user**: deine E-Mail + Passwort anlegen („Auto confirm" anhaken).
4. **Authentication → Sign In / Providers**: *Allow new users to sign up* **ausschalten** – dann kann sich niemand sonst registrieren.
5. **Project Settings → API**: `Project URL` und `anon public` Key kopieren.

## 2. App konfigurieren
In `config.js` URL und Anon-Key eintragen. Der Anon-Key ist öffentlich gedacht; geschützt wird über Login + Row Level Security.

## 3. Cloudflare Pages (keine eigene Domain nötig)
1. dash.cloudflare.com → *Workers & Pages* → *Create* → Reiter *Pages* → *Connect to Git*.
2. GitHub verbinden, Repo `davidhille/finance` freigeben und auswählen (Repo darf privat bleiben).
3. Framework preset *None*, Build command leer, Build output directory `/` → *Save and Deploy*.
4. Die App läuft unter `https://<projektname>.pages.dev`. Ab dann: `git push` auf `main` = Deploy.
5. Supabase → *Authentication* → *URL Configuration*: diese Adresse als *Site URL* eintragen.

Eine eigene Domain kann später unter *Custom domains* ergänzt werden.

## Bedienung
- **Import**: DKB-CSV (Umsätze → Export CSV) hochladen. Doppelte Buchungen werden erkannt, vorgemerkte übersprungen.
- **Buchungen**: Empfänger direkt im Feld umbenennen, Kategorie per Auswahl setzen.
  - Jede Zuordnung erzeugt eine Regel; gleiche Händler werden sofort mit zugeordnet.
  - *auto* = über Regel zugeordnet, *Vorschlag* = ähnlicher Händler, mit ✓ bestätigen.
  - Umbenennen gilt für alle Buchungen dieses Händlers mit demselben alten Namen.
- **Jahr**: Monats- und Jahressummen je Kategorie, Klick auf Kategorie zeigt Unterkategorien.
- **Jahresvergleich**: Kategorien über alle Jahre, Δ zum Vorjahr.
- **Kategorien & Regeln**: Kategorien/Unterkategorien verwalten, gelernte Regeln einsehen/löschen.

# Haushaltsbuch – Setup

## 1. Supabase
1. Neues Projekt anlegen (eigenes Projekt, nicht das von Nachspielzeit).
2. **SQL Editor** → Inhalt von `schema.sql` einfügen → *Run*.
3. **Authentication → Users → Add user**: deine E-Mail + Passwort anlegen („Auto confirm" anhaken).
4. **Authentication → Sign In / Providers**: *Allow new users to sign up* **ausschalten** – dann kann sich niemand sonst registrieren.
5. **Project Settings → API**: `Project URL` und `anon public` Key kopieren.

## 2. App konfigurieren
In `config.js` URL und Anon-Key eintragen. Der Anon-Key ist öffentlich gedacht; geschützt wird über Login + Row Level Security.

## 3. GitHub Pages
1. GitHub-Repo `finance` (im Gratis-Tarif muss es **öffentlich** sein, damit Pages läuft).
   Öffentlich ist nur der Code – deine Buchungen liegen in Supabase hinter Login + RLS.
2. Code pushen.
3. Repo → *Settings* → *Pages* → *Deploy from a branch* → `main` / `/ (root)` → *Save*.
4. Nach ca. 1 Minute erreichbar unter `https://davidhille.github.io/finance/`.
   Ab dann: `git push` auf `main` = Deploy.
5. Supabase → *Authentication* → *URL Configuration*: diese Adresse als *Site URL* eintragen.

Später umziehen (Cloudflare, eigene Domain) geht jederzeit ohne Codeänderung.

## Bedienung
- **Import**: DKB-CSV (Umsätze → Export CSV) hochladen. Doppelte Buchungen werden erkannt, vorgemerkte übersprungen.
- **Buchungen**: Empfänger direkt im Feld umbenennen, Kategorie per Auswahl setzen.
  - Jede Zuordnung erzeugt eine Regel; gleiche Händler werden sofort mit zugeordnet.
  - *auto* = über Regel zugeordnet, *Vorschlag* = ähnlicher Händler, mit ✓ bestätigen.
  - Umbenennen gilt für alle Buchungen dieses Händlers mit demselben alten Namen.
- **Jahr**: Monats- und Jahressummen je Kategorie, Klick auf Kategorie zeigt Unterkategorien.
- **Jahresvergleich**: Kategorien über alle Jahre, Δ zum Vorjahr.
- **Kategorien & Regeln**: Kategorien/Unterkategorien verwalten, gelernte Regeln einsehen/löschen.

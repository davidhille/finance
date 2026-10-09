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
- **Übersicht** (Start): Monat wählen (◀ ▶), Einnahmen/Ausgaben/Ergebnis mit Vormonat, Ausgaben je Kategorie mit Budget-Balken, Fixkosten-Kurzinfo, Tags, letzte Buchungen.
- **Import** (Knopf oben rechts): Konto wählen, DKB-CSV hochladen. Duplikate werden erkannt, falsches Konto wird gemeldet, unklare Fälle landen in „Mögliche Duplikate".
- **Buchungen**: Filter nach Jahr, Monat, Kategorie, Unterkategorie, Tag, Text oder Betrag (`36,73`, `>100`, `50-100`).
  - Empfänger direkt umbenennen, Kategorie per Auswahl (inkl. „＋ Neu anlegen…").
  - ✎ = Bearbeiten: Datum, Betrag, Konto, Kategorie, **Tags**, **Notiz**, „Regel daraus…".
  - **Mehrfachauswahl**: Kästchen anhaken → Leiste unten: Kategorie zuordnen, Tag setzen, löschen.
  - **⬇ CSV** exportiert die aktuell gefilterte Liste (Excel-tauglich).
- **Jahr**: Kennzahlen mit Vorjahresvergleich (gleicher Zeitraum), Monatstabelle; Betrag anklicken = Buchungen, 📈 = Verlauf.
- **Vergleich**: Jahresergebnis und Kategorien über alle Jahre, optional nur Jan–aktueller Monat.
- **Fixkosten**: × blendet einen Posten aus (unten „wieder aufnehmen"). Automatisch erkannte wiederkehrende Ausgaben/Einnahmen/Umbuchungen mit Monats- und Jahressumme, „beendet?"-Hinweis.
- **Einstellungen**: Konten, Kategorien (Budget pro Monat, Sichtbarkeit je Konto, Sortierung, 📈 Verlauf), eigene und gelernte Regeln, **Daten & Backup** (CSV aller Buchungen, JSON-Komplettbackup).
- **Zurück**: Browser-Zurück funktioniert überall; nach einem Klick aus Übersicht/Jahr/Fixkosten führt „← Zurück zu …" direkt zurück.
- **Als App**: Im Browser „Zum Startbildschirm hinzufügen" (iPhone: Teilen-Menü; Android/Chrome: Menü → App installieren).

## Datenbank-Migrationen
Neue Funktionen bringen ggf. eine Datei in `migrations/` mit – einmal im Supabase SQL Editor ausführen (001 = `schema.sql`, dann 002–008 der Reihe nach). `schema.sql` enthält immer den Gesamtstand für Neuinstallationen.

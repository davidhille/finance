-- Migration: Kategorien optional nur für ein Konto anzeigen (leer = alle Konten)
-- Einmal im Supabase SQL Editor ausführen.
alter table categories add column if not exists account_id uuid references accounts on delete set null;

-- Migration: Notizen & Tags an Buchungen, Monatsbudget je Kategorie
-- Einmal im Supabase SQL Editor ausführen.
alter table transactions add column if not exists note text;
alter table transactions add column if not exists tags text[] not null default '{}';
alter table categories   add column if not exists budget numeric(12,2);

notify pgrst, 'reload schema';

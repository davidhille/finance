-- Migration: Fixkosten-Posten ausblenden
-- Einmal im Supabase SQL Editor ausführen.
create table if not exists fixed_excludes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  match_key  text not null,          -- Händler|Konto|Richtung
  amount     numeric(12,2) not null, -- Betrag zum Zeitpunkt des Ausblendens (±12 % Toleranz)
  label      text,
  created_at timestamptz not null default now()
);
alter table fixed_excludes enable row level security;
drop policy if exists own_rows on fixed_excludes;
create policy own_rows on fixed_excludes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on fixed_excludes from anon;
grant select, insert, update, delete on fixed_excludes to authenticated;

notify pgrst, 'reload schema';

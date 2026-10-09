-- Migration: mehrere Konten (Gemeinschaft, Privat, ...)
-- Einmal im Supabase SQL Editor ausführen.

create table if not exists accounts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null,
  sort       int  not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table accounts enable row level security;
drop policy if exists own_rows on accounts;
create policy own_rows on accounts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on accounts from anon;
grant select, insert, update, delete on accounts to authenticated;

alter table transactions add column if not exists account_id uuid references accounts on delete cascade;
create index if not exists transactions_account on transactions (account_id);

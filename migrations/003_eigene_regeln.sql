-- Migration: eigene Regeln ("Wenn ... enthält ... dann Kategorie ...")
-- Einmal im Supabase SQL Editor ausführen.

create table if not exists user_rules (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  field          text not null default 'alle' check (field in ('alle','empfaenger','zweck')),
  pattern        text not null,
  direction      text not null default 'beide' check (direction in ('beide','ausgabe','einnahme')),
  account_id     uuid references accounts on delete cascade,
  payee          text,
  subcategory_id uuid not null references subcategories on delete cascade,
  sort           int  not null default 0,
  created_at     timestamptz not null default now()
);

alter table user_rules enable row level security;
drop policy if exists own_rows on user_rules;
create policy own_rows on user_rules for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on user_rules from anon;
grant select, insert, update, delete on user_rules to authenticated;

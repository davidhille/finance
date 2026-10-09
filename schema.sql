-- Finance App – Supabase Schema
-- Im Supabase-Dashboard unter "SQL Editor" komplett ausführen.

create extension if not exists pgcrypto;

-- Konten (z. B. Gemeinschaft, Privat)
create table if not exists accounts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null,
  sort       int  not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- Kategorien (z. B. Lebensmittel)
create table if not exists categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null,
  kind       text not null default 'ausgabe' check (kind in ('ausgabe','einnahme','umbuchung')),
  sort       int  not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- Unterkategorien (z. B. Edeka, Sonstiges)
create table if not exists subcategories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  category_id uuid not null references categories on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (category_id, name)
);

-- Buchungen
create table if not exists transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  account_id       uuid references accounts on delete cascade,
  booking_date     date not null,
  amount           numeric(12,2) not null,
  counterparty_raw text not null default '',   -- Originaltext aus der CSV
  payee            text not null default '',   -- bearbeitbarer Anzeigename
  purpose          text not null default '',
  iban             text not null default '',
  tx_type          text not null default '',
  subcategory_id   uuid references subcategories on delete set null,
  assign_state     text check (assign_state in ('manuell','auto','vorschlag')),
  hash             text not null,
  created_at       timestamptz not null default now(),
  unique (user_id, hash)
);
create index if not exists transactions_user_date on transactions (user_id, booking_date);
create index if not exists transactions_account on transactions (account_id);

-- Gelernte Regeln: Schlüssel aus Empfänger-Text -> Anzeigename + Unterkategorie
create table if not exists rules (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  match_key      text not null,
  payee          text,
  subcategory_id uuid references subcategories on delete cascade,
  hits           int not null default 1,
  updated_at     timestamptz not null default now(),
  unique (user_id, match_key)
);

-- Row Level Security: jeder sieht nur seine eigenen Daten
alter table accounts      enable row level security;
alter table categories    enable row level security;
alter table subcategories enable row level security;
alter table transactions  enable row level security;
alter table rules         enable row level security;

do $$
declare t text;
begin
  foreach t in array array['accounts','categories','subcategories','transactions','rules'] loop
    execute format('drop policy if exists own_rows on %I', t);
    execute format('create policy own_rows on %I for all to authenticated
                    using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- Zugriffsrechte (nötig, wenn "Automatically expose new tables" aus ist):
-- nur eingeloggte Nutzer, anonym kein Zugriff
revoke all on accounts, categories, subcategories, transactions, rules from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on accounts, categories, subcategories, transactions, rules to authenticated;

-- Eigene Regeln
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

-- Zusätzliche Bedingung Verwendungszweck (UND)
alter table user_rules add column if not exists purpose_pattern text;

-- Kategorie optional nur für ein Konto (leer = alle)
alter table categories add column if not exists account_id uuid references accounts on delete set null;

-- Migration: eigene Regeln mit zusätzlicher Bedingung auf den Verwendungszweck
-- Einmal im Supabase SQL Editor ausführen.
alter table user_rules add column if not exists purpose_pattern text;

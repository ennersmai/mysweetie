-- Add style column to characters: 'realistic' or 'anime'
alter table if exists public.characters
  add column if not exists style text not null default 'realistic';

-- Ensure only valid values are allowed
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'characters_style_check'
  ) then
    alter table public.characters
      add constraint characters_style_check
      check (style in ('realistic','anime'));
  end if;
end $$;

-- Backfill nulls just in case
update public.characters set style = 'realistic' where style is null;


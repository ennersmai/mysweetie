-- Add plan_tier column to profiles to support multiple paid tiers
alter table public.profiles
  add column if not exists plan_tier text not null default 'free';

-- Optional: backfill is_premium based on plan_tier for consistency
update public.profiles
  set is_premium = case when plan_tier in ('basic','premium') then true else false end;



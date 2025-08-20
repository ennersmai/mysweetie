-- Track free-tier voice trials used
alter table public.profiles
  add column if not exists voice_trials_used integer not null default 0;



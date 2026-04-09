-- Track basic-tier voice quota usage
alter table public.profiles
  add column if not exists voice_quota_used integer not null default 0;



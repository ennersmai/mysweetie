-- Schema for Premium AI Companion POC

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_premium boolean not null default false,
  subscription_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  avatar_url text,
  system_prompt text not null,
  voice_id text,
  style text not null default 'realistic' check (style in ('realistic','anime')),
  created_at timestamptz not null default now()
);

create table if not exists public.chat_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  role text not null check (role in ('system','user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_history_user_time on public.chat_history(user_id, created_at desc);
create index if not exists chat_history_char_time on public.chat_history(character_id, created_at desc);

create table if not exists public.character_galleries (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters(id) on delete cascade,
  image_path text not null,
  caption text,
  is_preview boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.trigger_phrases (
  id uuid primary key default gen_random_uuid(),
  phrase text not null,
  prompt_delta text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Storage buckets are created via dashboard/CLI: avatars, galleries



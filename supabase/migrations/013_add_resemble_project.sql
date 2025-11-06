-- Add Resemble.ai project storage table
-- This table stores the app-wide Resemble project UUID
-- The project should be created manually in Resemble dashboard and UUID inserted here

create table if not exists public.resemble_projects (
  id uuid primary key default gen_random_uuid(),
  project_uuid text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Create index on project_uuid for fast lookups
create index if not exists resemble_projects_uuid_idx on public.resemble_projects(project_uuid);

-- Add RLS policy (allow read for authenticated users, write only for service role)
alter table public.resemble_projects enable row level security;

-- Allow service role to read/write
create policy "Service role can manage resemble projects"
  on public.resemble_projects
  for all
  using (auth.role() = 'service_role');

-- Allow authenticated users to read (for backend service)
create policy "Authenticated users can read resemble projects"
  on public.resemble_projects
  for select
  using (auth.role() = 'authenticated' or auth.role() = 'service_role');


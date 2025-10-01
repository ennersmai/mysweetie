-- Add user_memories table for the memory system
create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id text not null, -- Can be a character UUID or 'system' for user profile memories
  memory_text text not null,
  importance_score integer not null default 5 check (importance_score >= 1 and importance_score <= 10),
  memory_type text not null check (memory_type in ('personal', 'emotional', 'factual', 'relational', 'preference')),
  conversation_context text,
  embedding_vector vector(1536), -- For semantic search (if using embeddings)
  created_at timestamptz not null default now(),
  last_accessed timestamptz not null default now(),
  access_count integer not null default 0
);

-- Indexes for performance
create index if not exists user_memories_user_character on public.user_memories(user_id, character_id);
create index if not exists user_memories_importance on public.user_memories(importance_score desc);
create index if not exists user_memories_last_accessed on public.user_memories(last_accessed desc);
create index if not exists user_memories_created_at on public.user_memories(created_at desc);

-- RLS policies
alter table public.user_memories enable row level security;

-- Users can only access their own memories
create policy "Users can view their own memories" on public.user_memories
  for select using (auth.uid() = user_id);

create policy "Users can insert their own memories" on public.user_memories
  for insert with check (auth.uid() = user_id);

create policy "Users can update their own memories" on public.user_memories
  for update using (auth.uid() = user_id);

create policy "Users can delete their own memories" on public.user_memories
  for delete using (auth.uid() = user_id);

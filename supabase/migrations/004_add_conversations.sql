-- Add conversations table to group chat messages
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  title text not null default 'New Chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Add conversation_id to chat_history
alter table public.chat_history add column if not exists conversation_id uuid references public.conversations(id) on delete cascade;

-- Create indexes for better performance
create index if not exists conversations_user_updated on public.conversations(user_id, updated_at desc);
create index if not exists conversations_character_updated on public.conversations(character_id, updated_at desc);
create index if not exists chat_history_conversation_time on public.chat_history(conversation_id, created_at asc);

-- Update existing chat history to have conversations
-- This creates one conversation per user-character pair for existing data
insert into public.conversations (user_id, character_id, title, created_at, updated_at)
select distinct 
  ch.user_id, 
  ch.character_id, 
  'Chat with ' || c.name,
  min(ch.created_at),
  max(ch.created_at)
from public.chat_history ch
join public.characters c on c.id = ch.character_id
where not exists (
  select 1 from public.conversations conv 
  where conv.user_id = ch.user_id and conv.character_id = ch.character_id
)
group by ch.user_id, ch.character_id, c.name;

-- Update chat_history to link to conversations
update public.chat_history 
set conversation_id = (
  select conv.id 
  from public.conversations conv 
  where conv.user_id = chat_history.user_id 
    and conv.character_id = chat_history.character_id
  limit 1
)
where conversation_id is null;

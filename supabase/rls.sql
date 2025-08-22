-- Enable RLS
alter table public.profiles enable row level security;
alter table public.chat_history enable row level security;
alter table public.characters enable row level security;
alter table public.character_galleries enable row level security;
alter table public.trigger_phrases enable row level security;
alter table public.conversations enable row level security;

-- Profiles: user can read own row; service role updates via backend only
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles for select
using (id = auth.uid());

-- No direct updates from client; write via service role only
drop policy if exists profiles_block_updates on public.profiles;
create policy profiles_block_updates
on public.profiles for update
to authenticated
using (false)
with check (false);

-- Insert profile row on signup via trigger (Supabase provides), or allow self-insert if missing
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
on public.profiles for insert
to authenticated
with check (id = auth.uid());

-- Chat history: user can read/write own
drop policy if exists chat_history_select_own on public.chat_history;
create policy chat_history_select_own
on public.chat_history for select
using (user_id = auth.uid());

drop policy if exists chat_history_insert_own on public.chat_history;
create policy chat_history_insert_own
on public.chat_history for insert
to authenticated
with check (user_id = auth.uid());

-- Characters: readable by anyone, authenticated users can create
drop policy if exists characters_read_all on public.characters;
create policy characters_read_all
on public.characters for select using (true);

drop policy if exists characters_insert_authenticated on public.characters;
create policy characters_insert_authenticated
on public.characters for insert
to authenticated
with check (true);

-- Character galleries: readable by anyone, authenticated users can create
drop policy if exists character_galleries_read_all on public.character_galleries;
create policy character_galleries_read_all
on public.character_galleries for select using (true);

drop policy if exists character_galleries_insert_authenticated on public.character_galleries;
create policy character_galleries_insert_authenticated
on public.character_galleries for insert
to authenticated
with check (true);

-- Trigger phrases: readable by anyone
drop policy if exists trigger_phrases_read_all on public.trigger_phrases;
create policy trigger_phrases_read_all
on public.trigger_phrases for select using (true);

-- Conversations: user can read/write own
drop policy if exists conversations_select_own on public.conversations;
create policy conversations_select_own
on public.conversations for select
using (user_id = auth.uid());

drop policy if exists conversations_insert_own on public.conversations;
create policy conversations_insert_own
on public.conversations for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists conversations_update_own on public.conversations;
create policy conversations_update_own
on public.conversations for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Storage policies for avatars bucket
insert into storage.buckets (id, name, public) 
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "Anyone can view avatars" on storage.objects for select using (bucket_id = 'avatars');
create policy "Authenticated users can upload avatars" on storage.objects for insert with check (bucket_id = 'avatars' and auth.role() = 'authenticated');
create policy "Users can update own avatars" on storage.objects for update using (bucket_id = 'avatars' and auth.role() = 'authenticated');
create policy "Users can delete own avatars" on storage.objects for delete using (bucket_id = 'avatars' and auth.role() = 'authenticated');

-- Storage policies for galleries bucket
insert into storage.buckets (id, name, public) 
values ('galleries', 'galleries', true)
on conflict (id) do nothing;

create policy "Anyone can view galleries" on storage.objects for select using (bucket_id = 'galleries');
create policy "Authenticated users can upload galleries" on storage.objects for insert with check (bucket_id = 'galleries' and auth.role() = 'authenticated');
create policy "Users can update galleries" on storage.objects for update using (bucket_id = 'galleries' and auth.role() = 'authenticated');
create policy "Users can delete galleries" on storage.objects for delete using (bucket_id = 'galleries' and auth.role() = 'authenticated');



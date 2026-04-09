-- Add DELETE policy for character_galleries table
drop policy if exists character_galleries_delete_authenticated on public.character_galleries;
create policy character_galleries_delete_authenticated
on public.character_galleries for delete
to authenticated
using (true);

-- Ensure storage policies exist for galleries deletion
drop policy if exists "Users can delete galleries" on storage.objects;
create policy "Users can delete galleries" on storage.objects for delete using (bucket_id = 'galleries' and auth.role() = 'authenticated');

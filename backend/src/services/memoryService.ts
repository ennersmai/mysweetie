import { supabase, supabaseAdmin } from '../config/database';

export const fetchUserMemories = async (userId: string, characterId: string) => {
  // Use supabaseAdmin to bypass RLS, as the user is already authenticated by middleware.
  // Include legacy rows where character_id may be NULL (pre-migration) and system memories
  const systemCharacterId = '00000000-0000-0000-0000-000000000000';
  const { data, error } = await supabaseAdmin
    .from('user_memories')
    .select('*')
    .eq('user_id', userId)
    .or(`character_id.eq.${characterId},character_id.is.null,character_id.eq.${systemCharacterId}`)
    .order('last_accessed', { ascending: false });

  return { data, error };
};

export const deleteUserMemory = async (userId: string, memoryId: string) => {
  // Use supabaseAdmin here as well to ensure users can delete their own memories
  const { error } = await supabaseAdmin
    .from('user_memories')
    .delete()
    .eq('id', memoryId)
    .eq('user_id', userId);

  return { error };
};

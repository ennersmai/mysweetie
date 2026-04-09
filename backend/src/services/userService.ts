import { supabase } from '../config/database';

interface ProfileUpdate {
  nsfw_enabled?: boolean;
  display_name?: string;
}

export const updateUserProfile = async (userId: string, updates: ProfileUpdate) => {
  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select();

  return { data, error };
};

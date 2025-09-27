-- Drop the existing RLS policy before altering the table
DROP POLICY IF EXISTS "Users can manage their own memories." ON public.user_memories;

-- Add the character_id column to the user_memories table if it doesn't exist
ALTER TABLE public.user_memories
ADD COLUMN IF NOT EXISTS character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE;

-- Update the unique constraint to include character_id
ALTER TABLE public.user_memories
DROP CONSTRAINT IF EXISTS unique_memory_per_user,
DROP CONSTRAINT IF EXISTS unique_memory_per_user_and_character, -- Drop the new one too, just in case
ADD CONSTRAINT unique_memory_per_user_and_character UNIQUE (user_id, character_id, memory_text);

-- Recreate the RLS policy with the new structure
CREATE POLICY "Users can manage their own memories."
ON public.user_memories FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

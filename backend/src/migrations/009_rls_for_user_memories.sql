-- Enable Row Level Security if not already enabled
ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts
DROP POLICY IF EXISTS "Users can manage their own memories." ON public.user_memories;

-- Create a policy that allows users to perform all operations (SELECT, INSERT, UPDATE, DELETE) on their own memories.
-- This is a common pattern for tables that are exclusively managed by the user who owns the data.
CREATE POLICY "Users can manage their own memories."
ON public.user_memories FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

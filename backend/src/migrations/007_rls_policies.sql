-- Enable Row Level Security if not already enabled
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts
DROP POLICY IF EXISTS "Users can view their own conversations." ON public.conversations;
DROP POLICY IF EXISTS "Users can insert their own conversations." ON public.conversations;
DROP POLICY IF EXISTS "Users can update their own conversations." ON public.conversations;
DROP POLICY IF EXISTS "Users can delete their own conversations." ON public.conversations;

-- Create a policy that allows users to SELECT their own conversations
CREATE POLICY "Users can view their own conversations."
ON public.conversations FOR SELECT
USING (auth.uid() = user_id);

-- Create a policy that allows users to INSERT conversations for themselves
CREATE POLICY "Users can insert their own conversations."
ON public.conversations FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Create a policy that allows users to UPDATE their own conversations
CREATE POLICY "Users can update their own conversations."
ON public.conversations FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Create a policy that allows users to DELETE their own conversations
CREATE POLICY "Users can delete their own conversations."
ON public.conversations FOR DELETE
USING (auth.uid() = user_id);

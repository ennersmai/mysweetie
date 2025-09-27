-- Enable Row Level Security if not already enabled
ALTER TABLE public.chat_history ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts
DROP POLICY IF EXISTS "Users can view their own chat history." ON public.chat_history;
DROP POLICY IF EXISTS "Users can insert their own chat history." ON public.chat_history;

-- Create a policy that allows users to SELECT chat history
-- for conversations they are a part of.
CREATE POLICY "Users can view their own chat history."
ON public.chat_history FOR SELECT
USING (
  conversation_id IN (
    SELECT id FROM conversations WHERE user_id = auth.uid()
  )
);

-- Create a policy that allows users to INSERT chat history
-- for conversations they are a part of.
CREATE POLICY "Users can insert their own chat history."
ON public.chat_history FOR INSERT
WITH CHECK (
  conversation_id IN (
    SELECT id FROM conversations WHERE user_id = auth.uid()
  )
);

-- Function to atomically decrement voice credits
-- This prevents race conditions when multiple voice calls happen simultaneously
CREATE OR REPLACE FUNCTION decrement_voice_credits(user_id uuid, amount integer DEFAULT 1)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
  SET voice_credits = GREATEST(0, voice_credits - amount)
  WHERE id = user_id;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION decrement_voice_credits(uuid, integer) TO authenticated;


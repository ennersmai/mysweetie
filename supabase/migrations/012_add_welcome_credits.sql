-- Add welcome credits and text message tracking columns
alter table public.profiles
  add column if not exists welcome_credits integer not null default 20,
  add column if not exists text_messages_today integer not null default 0,
  add column if not exists last_text_reset_date date,
  add column if not exists has_used_welcome_credits boolean not null default false;

-- Add indexes for efficient queries
create index if not exists idx_profiles_welcome_credits on public.profiles(welcome_credits);
create index if not exists idx_profiles_text_messages_today on public.profiles(text_messages_today);

-- Initialize welcome credits for existing users who have 0
update public.profiles 
set welcome_credits = 20
where welcome_credits = 0;

-- Function to atomically decrement welcome credits
CREATE OR REPLACE FUNCTION decrement_welcome_credits(user_id uuid, amount integer DEFAULT 1)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  remaining_credits integer;
BEGIN
  UPDATE profiles
  SET welcome_credits = GREATEST(0, welcome_credits - amount),
      has_used_welcome_credits = CASE 
        WHEN welcome_credits - amount <= 0 THEN true 
        ELSE has_used_welcome_credits 
      END
  WHERE id = user_id
  RETURNING welcome_credits INTO remaining_credits;
  
  RETURN COALESCE(remaining_credits, 0);
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION decrement_welcome_credits(uuid, integer) TO authenticated;

-- Function to check and reset daily text message counter
CREATE OR REPLACE FUNCTION check_and_reset_daily_text_messages(user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_count integer;
  reset_date date;
  today_date date := CURRENT_DATE;
BEGIN
  -- Get current values
  SELECT text_messages_today, last_text_reset_date
  INTO current_count, reset_date
  FROM profiles
  WHERE id = user_id;
  
  -- Reset if it's a new day
  IF reset_date IS NULL OR reset_date < today_date THEN
    UPDATE profiles
    SET text_messages_today = 0,
        last_text_reset_date = today_date
    WHERE id = user_id;
    current_count := 0;
  END IF;
  
  RETURN COALESCE(current_count, 0);
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION check_and_reset_daily_text_messages(uuid) TO authenticated;

-- Function to increment daily text message counter
CREATE OR REPLACE FUNCTION increment_daily_text_messages(user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_count integer;
BEGIN
  -- First ensure counter is reset if needed
  PERFORM check_and_reset_daily_text_messages(user_id);
  
  -- Increment counter
  UPDATE profiles
  SET text_messages_today = text_messages_today + 1
  WHERE id = user_id
  RETURNING text_messages_today INTO new_count;
  
  RETURN COALESCE(new_count, 0);
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION increment_daily_text_messages(uuid) TO authenticated;


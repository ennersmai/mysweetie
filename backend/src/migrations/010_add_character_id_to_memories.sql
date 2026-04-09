-- ============================================================================
-- MySweetie.AI Memory System - System Character Migration
-- Version: 010
-- Description: Add System character for user profile memories and update schema
-- ============================================================================

-- 1. CREATE SYSTEM CHARACTER FOR USER PROFILE MEMORIES
-- ============================================================================
INSERT INTO public.characters (
    id,
    name,
    description,
    avatar_url,
    system_prompt,
    voice_id,
    style,
    created_at
) VALUES (
    '00000000-0000-0000-0000-000000000000', -- Special UUID for system character
    'System',
    'System character for storing user profile memories that apply to all characters',
    NULL,
    'You are a system character used to store user profile information that should be remembered across all character interactions.',
    NULL,
    'realistic',
    NOW()
) ON CONFLICT (id) DO NOTHING;

-- 2. UPDATE USER_MEMORIES TABLE TO SUPPORT CHARACTER_ID
-- ============================================================================

-- Drop the existing RLS policy before altering the table
DROP POLICY IF EXISTS "Users can view own memories" ON public.user_memories;
DROP POLICY IF EXISTS "Users can insert own memories" ON public.user_memories;
DROP POLICY IF EXISTS "Users can update own memories" ON public.user_memories;
DROP POLICY IF EXISTS "Users can delete own memories" ON public.user_memories;

-- Add the character_id column to the user_memories table if it doesn't exist
ALTER TABLE public.user_memories
ADD COLUMN IF NOT EXISTS character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE;

-- Update the unique constraint to include character_id
ALTER TABLE public.user_memories
DROP CONSTRAINT IF EXISTS unique_memory_per_user,
DROP CONSTRAINT IF EXISTS unique_memory_per_user_and_character,
ADD CONSTRAINT unique_memory_per_user_and_character UNIQUE (user_id, character_id, memory_text);

-- 3. UPDATE EXISTING MEMORIES TO USE SYSTEM CHARACTER
-- ============================================================================

-- Update any existing memories without character_id to use the system character
UPDATE public.user_memories 
SET character_id = '00000000-0000-0000-0000-000000000000'
WHERE character_id IS NULL;

-- 4. RECREATE RLS POLICIES
-- ============================================================================

-- User memories policies
CREATE POLICY "Users can view own memories" ON public.user_memories
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own memories" ON public.user_memories
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own memories" ON public.user_memories
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own memories" ON public.user_memories
    FOR DELETE USING (auth.uid() = user_id);

-- 5. UPDATE MEMORY LIMIT ENFORCEMENT FUNCTION
-- ============================================================================

-- Update the enforce_memory_limit function to handle system character
CREATE OR REPLACE FUNCTION enforce_memory_limit()
RETURNS TRIGGER AS $$
DECLARE
    current_count INTEGER;
    user_limit INTEGER;
    user_tier TEXT;
BEGIN
    -- Get user's subscription tier and memory limit
    SELECT subscription_tier, memory_limit 
    INTO user_tier, user_limit
    FROM public.profiles 
    WHERE id = NEW.user_id;
    
    -- Set default limits based on tier if not set
    IF user_limit IS NULL OR user_limit = 0 THEN
        CASE user_tier
            WHEN 'basic' THEN user_limit := 50;
            WHEN 'premium' THEN user_limit := 100;
            ELSE user_limit := 20;  -- Free users get 20 memories
        END CASE;
        
        -- Update the profile with the limit
        UPDATE public.profiles 
        SET memory_limit = user_limit 
        WHERE id = NEW.user_id;
    END IF;
    
    -- Count existing memories for this user and character
    SELECT COUNT(*) 
    INTO current_count
    FROM public.user_memories 
    WHERE user_id = NEW.user_id AND character_id = NEW.character_id;
    
    -- Check if limit would be exceeded
    IF current_count >= user_limit THEN
        -- For free users, reject the insertion
        IF user_tier = 'free' THEN
            RAISE EXCEPTION 'Memory limit reached. Upgrade to premium for persistent memories.';
        END IF;
        
        -- For premium users, remove oldest/least important memory
        DELETE FROM public.user_memories 
        WHERE id = (
            SELECT id 
            FROM public.user_memories 
            WHERE user_id = NEW.user_id AND character_id = NEW.character_id
            ORDER BY importance_score ASC, last_accessed ASC 
            LIMIT 1
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. MIGRATION COMPLETE
-- ============================================================================

-- Log migration completion
DO $$
BEGIN
    RAISE NOTICE 'System Character Migration 010 completed successfully!';
    RAISE NOTICE 'Features added:';
    RAISE NOTICE '- System character (UUID: 00000000-0000-0000-0000-000000000000)';
    RAISE NOTICE '- character_id column added to user_memories';
    RAISE NOTICE '- Updated memory limit enforcement';
    RAISE NOTICE '- RLS policies recreated';
    RAISE NOTICE '- Existing memories migrated to system character';
END $$;

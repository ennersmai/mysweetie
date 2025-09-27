-- MySweetie.AI Memory System Database Migration
-- Version: 006
-- Description: Add persistent memory system with orchestrator and premium features

-- ============================================================================
-- 1. USER MEMORIES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.user_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
    memory_text TEXT NOT NULL,
    importance_score INTEGER NOT NULL CHECK (importance_score >= 1 AND importance_score <= 10),
    memory_type TEXT NOT NULL CHECK (memory_type IN ('personal', 'emotional', 'factual', 'relational', 'preference')),
    conversation_context TEXT,
    embedding_vector TEXT, -- JSON string for embeddings (when vector extension is available)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    access_count INTEGER DEFAULT 0,
    
    -- Composite index for efficient querying
    CONSTRAINT unique_memory_per_user UNIQUE (user_id, character_id, memory_text)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_memories_user_character ON public.user_memories(user_id, character_id);
CREATE INDEX IF NOT EXISTS idx_user_memories_importance ON public.user_memories(importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_user_memories_last_accessed ON public.user_memories(last_accessed DESC);
CREATE INDEX IF NOT EXISTS idx_user_memories_type ON public.user_memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_user_memories_created_at ON public.user_memories(created_at DESC);

-- ============================================================================
-- 2. MEMORY ORCHESTRATOR DECISIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.memory_orchestrator_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    selected_memories UUID[] DEFAULT '{}', -- Array of memory IDs
    reasoning TEXT,
    processing_time_ms INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_orchestrator_user_character ON public.memory_orchestrator_decisions(user_id, character_id);
CREATE INDEX IF NOT EXISTS idx_orchestrator_conversation ON public.memory_orchestrator_decisions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_orchestrator_created_at ON public.memory_orchestrator_decisions(created_at DESC);

-- ============================================================================
-- 3. UPDATE PROFILES TABLE FOR PREMIUM FEATURES
-- ============================================================================
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS memory_limit INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS nsfw_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'free' CHECK (subscription_tier IN ('free', 'basic', 'premium')),
ADD COLUMN IF NOT EXISTS voice_usage_daily INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS voice_limit_daily INTEGER DEFAULT 10,
ADD COLUMN IF NOT EXISTS last_voice_reset DATE DEFAULT CURRENT_DATE;

-- ============================================================================
-- 4. MEMORY SYSTEM FUNCTIONS
-- ============================================================================

-- Function to update memory access tracking
CREATE OR REPLACE FUNCTION update_memory_access(memory_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE public.user_memories 
    SET 
        last_accessed = NOW(),
        access_count = access_count + 1
    WHERE id = memory_id;
END;
$$ LANGUAGE plpgsql;

-- Function to enforce memory limits based on subscription tier
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
            ELSE user_limit := 0;  -- Free users get 0 memories
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

-- Create trigger for memory limit enforcement
DROP TRIGGER IF EXISTS trigger_enforce_memory_limit ON public.user_memories;
CREATE TRIGGER trigger_enforce_memory_limit
    BEFORE INSERT ON public.user_memories
    FOR EACH ROW
    EXECUTE FUNCTION enforce_memory_limit();

-- Function to reset daily voice usage
CREATE OR REPLACE FUNCTION reset_daily_voice_usage()
RETURNS VOID AS $$
BEGIN
    UPDATE public.profiles 
    SET 
        voice_usage_daily = 0,
        last_voice_reset = CURRENT_DATE
    WHERE last_voice_reset < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 5. ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- Enable RLS on new tables
ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_orchestrator_decisions ENABLE ROW LEVEL SECURITY;

-- User memories policies
DROP POLICY IF EXISTS "Users can view own memories" ON public.user_memories;
CREATE POLICY "Users can view own memories" ON public.user_memories
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own memories" ON public.user_memories;
CREATE POLICY "Users can insert own memories" ON public.user_memories
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own memories" ON public.user_memories;
CREATE POLICY "Users can update own memories" ON public.user_memories
    FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own memories" ON public.user_memories;
CREATE POLICY "Users can delete own memories" ON public.user_memories
    FOR DELETE USING (auth.uid() = user_id);

-- Memory orchestrator decisions policies
DROP POLICY IF EXISTS "Users can view own orchestrator decisions" ON public.memory_orchestrator_decisions;
CREATE POLICY "Users can view own orchestrator decisions" ON public.memory_orchestrator_decisions
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "System can insert orchestrator decisions" ON public.memory_orchestrator_decisions;
CREATE POLICY "System can insert orchestrator decisions" ON public.memory_orchestrator_decisions
    FOR INSERT WITH CHECK (true); -- Service role can insert

-- ============================================================================
-- 6. UPDATE EXISTING USER PROFILES WITH DEFAULT MEMORY LIMITS
-- ============================================================================

-- Update existing profiles based on their premium status
UPDATE public.profiles 
SET 
    subscription_tier = CASE 
        WHEN is_premium = true THEN 'premium'
        ELSE 'free'
    END,
    memory_limit = CASE 
        WHEN is_premium = true THEN 100
        ELSE 0
    END,
    voice_limit_daily = CASE 
        WHEN is_premium = true THEN 999999  -- Unlimited for premium
        ELSE 10
    END
WHERE memory_limit IS NULL OR memory_limit = 0;

-- ============================================================================
-- 7. CREATE INDEXES FOR CHAT HISTORY TABLE (if not exists)
-- ============================================================================

-- Add conversation_id index if not exists
CREATE INDEX IF NOT EXISTS idx_chat_history_conversation ON public.chat_history(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_user_character ON public.chat_history(user_id, character_id);

-- ============================================================================
-- 8. MIGRATION COMPLETE
-- ============================================================================

-- Log migration completion
DO $$
BEGIN
    RAISE NOTICE 'Memory System Migration 006 completed successfully!';
    RAISE NOTICE 'Features added:';
    RAISE NOTICE '- User memories table with importance scoring';
    RAISE NOTICE '- Memory orchestrator decisions tracking';
    RAISE NOTICE '- Premium feature support (Basic: 50 memories, Premium: 100 memories)';
    RAISE NOTICE '- NSFW mode configuration';
    RAISE NOTICE '- Voice usage tracking';
    RAISE NOTICE '- Automatic memory limit enforcement';
    RAISE NOTICE '- Row Level Security policies';
END $$;

// User and Authentication Types
export interface User {
  id: string;
  email: string;
  role?: string;
}

export interface UserProfile {
  id: string;
  email: string;
  is_premium: boolean;
  subscription_tier: 'free' | 'basic' | 'premium';
  memory_limit: number;
  nsfw_enabled: boolean;
  voice_usage_daily: number;
  voice_limit_daily: number;
  created_at: string;
  updated_at: string;
}

// Memory System Types
export interface Memory {
  id: string;
  user_id: string;
  character_id: string;
  memory_text: string;
  importance_score: number;
  memory_type: 'personal' | 'emotional' | 'factual' | 'relational' | 'preference';
  conversation_context: string;
  embedding_vector?: number[];
  created_at: string;
  last_accessed: string;
  access_count: number;
}

export interface MemoryExtractionRequest {
  conversation: ChatMessage[];
  user_id: string;
  character_id: string;
  conversation_id?: string;
  user_persona?: string | null;
}

export interface MemoryExtractionResult {
  memories: Partial<Memory>[];
  reasoning: string;
  processing_time_ms: number;
}

export interface MemoryOrchestratorDecision {
  id: string;
  user_id: string;
  character_id: string;
  conversation_id?: string;
  selected_memories: string[]; // Memory IDs
  reasoning: string;
  processing_time: number;
  created_at: string;
}

// Chat System Types
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

export interface ChatRequest {
  message: string;
  character_id: string;
  conversation_id?: string;
  model_key?: string;
  fantasy_mode?: boolean;
  nsfw_mode?: boolean;
  voice_enabled?: boolean;
}

export interface ChatResponse {
  message: string;
  character_id: string;
  conversation_id: string;
  memories_used: string[]; // Memory IDs that were injected
  model_used: string;
  processing_time_ms: number;
  voice_url?: string;
}

// Character Types
export interface Character {
  id: string;
  name: string;
  description: string;
  avatar_url: string | null;
  system_prompt: string;
  created_at: string;
  updated_at: string;
}

// Conversation Types
export interface Conversation {
  id: string;
  user_id: string;
  character_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

// Subscription and Premium Types
export interface SubscriptionLimits {
  memory_limit: number;
  voice_daily_limit: number;
  can_create_characters: boolean;
  can_access_advanced_models: boolean;
  can_upload_gallery: boolean;
  can_use_fantasy_mode: boolean;
  can_use_nsfw_mode: boolean;
}

export interface UsageStats {
  voice_used_today: number;
  memories_stored: number;
  characters_created: number;
  conversations_today: number;
}

// Voice System Types
export interface VoiceRequest {
  text: string;
  voice_key?: string;
  character_id?: string;
  user_id: string;
}

export interface VoiceResponse {
  audio_url: string;
  duration_seconds: number;
  voice_used: string;
  usage_count: number;
}

// NSFW System Types
export interface NSFWPromptTemplate {
  id: string;
  name: string;
  jailbreak_prompt: string;
  intensity_level: 'mild' | 'moderate' | 'strong';
  character_specific: boolean;
}

// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
}

export interface ApiError {
  error: string;
  message: string;
  code?: string;
  details?: any;
  timestamp: string;
}

// Memory Orchestrator Types
export interface MemoryRetrievalRequest {
  user_id: string;
  character_id: string;
  conversation_context: string;
  max_memories?: number;
}

export interface MemoryRetrievalResponse {
  memories: Memory[];
  relevance_scores: number[];
  total_available: number;
  cache_hit: boolean;
}

// Database Types
export interface DatabaseConfig {
  supabase_url: string;
  supabase_anon_key: string;
  supabase_service_key: string;
}

export interface RedisConfig {
  url: string;
  password?: string;
  retry_attempts: number;
}

// Request Extensions
export interface AuthenticatedRequest extends Request {
  user?: User;
}

// Environment Configuration
export interface AppConfig {
  port: number;
  node_env: string;
  api_prefix: string;
  cors_origin: string;
  log_level: string;
  premium_memory_limit_basic: number;
  premium_memory_limit_full: number;
  free_voice_daily_limit: number;
  nsfw_jailbreak_enabled: boolean;
}

// Job Queue Types (for background processing)
export interface MemoryExtractionJob {
  user_id: string;
  character_id: string;
  conversation_id?: string;
  messages: ChatMessage[];
  priority: 'low' | 'normal' | 'high';
}

export interface VoiceSynthesisJob {
  user_id: string;
  text: string;
  voice_key: string;
  character_id?: string;
  callback_url?: string;
}

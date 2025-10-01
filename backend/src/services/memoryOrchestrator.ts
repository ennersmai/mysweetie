import { logger } from '../utils/logger';
import { ChatMessage, Memory, MemoryExtractionRequest, MemoryExtractionResult, MemoryRetrievalRequest, MemoryRetrievalResponse } from '../types';
import { supabaseAdmin } from '../config/database';
import { redis } from '../config/redis';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const MEMORY_ORCHESTRATOR_MODEL = process.env.MEMORY_ORCHESTRATOR_MODEL || 'mistralai/mistral-7b-instruct:free';
const MEMORY_MAX_CONTEXT_LENGTH = parseInt(process.env.MEMORY_MAX_CONTEXT_LENGTH || '4000');

export class MemoryOrchestrator {
  private static instance: MemoryOrchestrator;

  public static getInstance(): MemoryOrchestrator {
    if (!MemoryOrchestrator.instance) {
      MemoryOrchestrator.instance = new MemoryOrchestrator();
    }
    return MemoryOrchestrator.instance;
  }

  /**
   * Extract important memories from a conversation using Mistral Small
   */
  public async extractMemories(request: MemoryExtractionRequest): Promise<MemoryExtractionResult> {
    const startTime = Date.now();
    logger.info({ message: 'Extracting memories with Mistral model', ...request });
    
    try {
      const prompt = this.buildMemoryExtractionPrompt(request.conversation, request.user_persona);
      
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://mysweetie.ai',
          'X-Title': 'MySweetie.AI Memory Orchestrator'
        },
        body: JSON.stringify({
          model: MEMORY_ORCHESTRATOR_MODEL,
          messages: [
            {
              role: 'system',
              content: 'You are a memory extraction AI for MySweetie.AI. Extract important memories from conversations and score their importance 1-10.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 1000,
          temperature: 0.2, // Lower temperature for consistent extraction
        })
      });

      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
      }

      type OpenRouterChatCompletion = {
        id: string;
        choices: Array<{
          index: number;
          message: { role: string; content: string };
          finish_reason?: string;
        }>;
        created?: number;
        model?: string;
        object?: string;
      };

      const data = (await response.json()) as OpenRouterChatCompletion;
      const content = data?.choices?.[0]?.message?.content ?? '';
      const result = this.parseMemoryExtractionResponse(content, request);
      
      result.processing_time_ms = Date.now() - startTime;
      
      logger.info(`Extracted ${result.memories.length} memories in ${result.processing_time_ms}ms`);
      return result;

    } catch (error) {
      logger.error('Memory extraction failed:', error);
      return {
        memories: [],
        reasoning: `Extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        processing_time_ms: Date.now() - startTime
      };
    }
  }

  /**
   * Retrieve relevant memories for conversation context
   */
  public async retrieveRelevantMemories(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResponse> {
    try {
      // Check cache first
      const cacheKey = `memories:${request.user_id}:${request.character_id}`;
      const cached = await redis.getCachedMemories(request.user_id, request.character_id);
      
      if (cached) {
        logger.debug('Using cached memories');
        return {
          memories: cached.slice(0, request.max_memories || 10),
          relevance_scores: cached.map(() => 0.8), // Cached scores
          total_available: cached.length,
          cache_hit: true
        };
      }

      // Query database for memories
      const { data: memories, error } = await supabaseAdmin
        .from('user_memories')
        .select('*')
        .eq('user_id', request.user_id)
        .eq('character_id', request.character_id)
        .order('importance_score', { ascending: false })
        .order('last_accessed', { ascending: false })
        .limit(request.max_memories || 10);

      if (error) {
        throw error;
      }

      // Score relevance using semantic similarity (simplified for now)
      const relevantMemories = await this.scoreMemoryRelevance(
        memories || [], 
        request.conversation_context
      );

      // Cache the results
      await redis.cacheMemories(request.user_id, request.character_id, relevantMemories);

      return {
        memories: relevantMemories,
        relevance_scores: relevantMemories.map(m => m.importance_score / 10), // Convert to 0-1 scale
        total_available: memories?.length || 0,
        cache_hit: false
      };

    } catch (error) {
      logger.error('Memory retrieval failed:', error);
      return {
        memories: [],
        relevance_scores: [],
        total_available: 0,
        cache_hit: false
      };
    }
  }

  /**
   * Store extracted memories in database
   */
  public async storeMemories(
    memories: Partial<Memory>[], 
    userId: string, 
    characterId: string
  ): Promise<void> {
    try {
      if (memories.length === 0) return;

      // Get user's plan tier to enforce memory limits
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('plan_tier, is_premium')
        .eq('id', userId)
        .maybeSingle();

      const planTier = profile?.plan_tier || (profile?.is_premium ? 'basic' : 'free');
      
      // Determine memory limit based on plan
      const memoryLimits: { [key: string]: number } = {
        'free': 20,
        'basic': 50,
        'premium': 100
      };
      const memoryLimit = memoryLimits[planTier] || 20;

      // Count current memories for this user-character pair
      const { count: currentMemoryCount } = await supabaseAdmin
        .from('user_memories')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('character_id', characterId);

      const existingCount = currentMemoryCount || 0;

      // If at limit, delete lowest importance memories to make room
      if (existingCount >= memoryLimit) {
        const memoriesToDelete = Math.max(1, memories.length);
        const { data: lowestMemories } = await supabaseAdmin
          .from('user_memories')
          .select('id')
          .eq('user_id', userId)
          .eq('character_id', characterId)
          .order('importance_score', { ascending: true })
          .limit(memoriesToDelete);

        if (lowestMemories && lowestMemories.length > 0) {
          await supabaseAdmin
            .from('user_memories')
            .delete()
            .in('id', lowestMemories.map(m => m.id));
          
          logger.info({ 
            message: 'Deleted low-importance memories to make room', 
            userId, 
            characterId,
            deletedCount: lowestMemories.length,
            memoryLimit 
          });
        }
      }

      const memoriesToUpsert = memories.map(memory => ({
        user_id: userId,
        character_id: characterId,
        memory_text: memory.memory_text,
        importance_score: memory.importance_score,
        memory_type: memory.memory_type,
        conversation_context: memory.conversation_context,
        // Supabase will handle created_at on its own for new rows
        last_accessed: new Date().toISOString(),
        // access_count will be handled by the database trigger or upsert logic
      }));

      const { error } = await supabaseAdmin
        .from('user_memories')
        .upsert(memoriesToUpsert, { onConflict: 'user_id,character_id,memory_text' });

      if (error) {
        // Log the error but don't re-throw, as it's a background process
        // and shouldn't crash the main chat flow.
        logger.error({ message: 'Memory upsert failed', error });
        return; // Stop execution if upsert fails
      }

      // Invalidate cache
      // Note: `redis.getCachedMemories` seems to be used for retrieval, not invalidation.
      // Assuming there's a `redis.deleteCachedMemories` or similar, or that we just overwrite.
      // For now, let's ensure the cache is updated by re-caching with fresh data later.
      // We will clear the cache to force a refresh on next retrieval.
      await redis.deleteCachedMemories(userId, characterId);
      
      logger.info({ 
        message: 'Memory storage completed', 
        userId, 
        characterId,
        memoriesUpserted: memories.length,
        memoryLimit,
        planTier 
      });

    } catch (error) {
      // Catch any other unexpected errors
      logger.error({ message: 'An unexpected error occurred during memory storage', error });
      // Do not re-throw, as this is a background task.
    }
  }

  /**
   * Build memory extraction prompt for Mistral
   */
  private buildMemoryExtractionPrompt(conversation: ChatMessage[], userPersona?: string | null): string {
    const conversationText = conversation
      .map(msg => `${msg.role}: ${msg.content}`)
      .join('\n');

    const personaName = userPersona || 'the user';

    return `
Analyze the following conversation and extract CRITICAL memories. A critical memory is a piece of information that is ESSENTIAL for understanding ${personaName}'s personality, backstory, or their relationship with the character.

CONVERSATION:
${conversationText}

IMPORTANT: You are extracting memories about ${personaName} (the user), NOT about the character. The character is the one speaking in the conversation.

GENDER CLARIFICATION: The character is always female, the user (${personaName}) is always male.

INSTRUCTIONS:
1. Extract 0-3 memories. It is VERY IMPORTANT to extract nothing if no new critical information is revealed.
2. Focus ONLY on:
    - Core identity facts about ${personaName} (occupation, defining relationships).
    - Deep personal preferences and values of ${personaName}.
    - Major life events or emotional turning points in ${personaName}'s life.
    - The established dynamics of the ${personaName}-character relationship (e.g., "${personaName} sees the character as a mentor").
3. AVOID extracting:
    - Trivial facts (e.g., favorite color, what they ate for lunch).
    - Casual greetings, pleasantries, or conversational filler.
    - Information that is temporary or likely to change.
4. Score the importance from 1-10. A score of 7-10 is required for a memory to be considered critical.
5. Summarize the memory from the character's perspective, using ${personaName}'s name (e.g., "I learned that ${personaName} works as a teacher.").
6. The memory type MUST be exactly one of: "personal", "emotional", "factual", "relational", "preference".

RESPOND IN THIS EXACT JSON FORMAT:
{
  "memories": [
    {
      "text": "specific memory text, from the character's perspective, using ${personaName}'s name",
      "importance": 9,
      "type": "personal",
      "context": "brief context about when this was mentioned"
    }
  ],
  "reasoning": "brief explanation of why these memories were (or were not) selected"
}

JSON RESPONSE:`;
  }

  /**
   * Parse Mistral's memory extraction response
   */
  private parseMemoryExtractionResponse(
    response: string, 
    request: MemoryExtractionRequest
  ): MemoryExtractionResult {
    try {
      // Extract JSON from response: try fenced code first, then first {...}
      let jsonText: string | null = null;
      const fenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (fenceMatch && fenceMatch[1] && fenceMatch[1].includes('{')) {
        jsonText = fenceMatch[1];
      }
      if (!jsonText) {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonText = jsonMatch[0];
      }
      if (!jsonText) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonText);

      const normalizeMemoryType = (t: any): 'personal' | 'emotional' | 'factual' | 'relational' | 'preference' => {
        const raw = (typeof t === 'string' ? t : '').toLowerCase().trim();
        if (raw === 'personal') return 'personal';
        if (raw === 'emotional' || raw === 'emotion') return 'emotional';
        if (raw === 'factual' || raw === 'fact') return 'factual';
        if (raw === 'relational' || raw === 'relationship' || raw === 'relationships') return 'relational';
        if (raw === 'preference' || raw === 'preferences' || raw === 'habit' || raw === 'habits') return 'preference';
        return 'factual';
      };
      
      const memories: Partial<Memory>[] = (parsed.memories || []).map((mem: any) => ({
        memory_text: mem.text,
        importance_score: Math.max(1, Math.min(10, mem.importance || 5)),
        memory_type: normalizeMemoryType(mem.type),
        conversation_context: mem.context || 'General conversation',
        user_id: request.user_id,
        character_id: request.character_id
      }));

      return {
        memories,
        reasoning: parsed.reasoning || 'Memories extracted by Mistral orchestrator',
        processing_time_ms: 0 // Will be set by caller
      };

    } catch (error) {
      logger.error('Failed to parse memory extraction response:', error);
      return {
        memories: [],
        reasoning: `Parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        processing_time_ms: 0
      };
    }
  }

  /**
   * Score memory relevance to current conversation context
   */
  private async scoreMemoryRelevance(
    memories: Memory[], 
    context: string
  ): Promise<Memory[]> {
    // For now, use simple keyword matching and importance scores
    // In the future, we could use embeddings for semantic similarity
    
    const contextWords = context.toLowerCase().split(/\s+/);
    
    return memories.map(memory => {
      const memoryWords = memory.memory_text.toLowerCase().split(/\s+/);
      const overlap = contextWords.filter(word => 
        memoryWords.some(memWord => memWord.includes(word) || word.includes(memWord))
      ).length;
      
      // Boost score based on word overlap and recency
      const relevanceBoost = Math.min(2, overlap * 0.2);
      const accessBoost = memory.access_count > 0 ? 0.5 : 0;
      
      return {
        ...memory,
        relevance_score: (memory.importance_score + relevanceBoost + accessBoost) / 10
      };
    }).sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
  }

  /**
   * Log orchestrator decision for analytics
   */
  public async logOrchestratorDecision(
    userId: string,
    characterId: string,
    conversationId: string | undefined,
    selectedMemoryIds: string[],
    reasoning: string,
    processingTime: number
  ): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('memory_orchestrator_decisions')
        .insert({
          user_id: userId,
          character_id: characterId,
          conversation_id: conversationId,
          selected_memories: selectedMemoryIds,
          reasoning,
          processing_time_ms: processingTime
        });

      if (error) {
        logger.error('Failed to log orchestrator decision:', error);
      }
    } catch (error) {
      logger.error('Error logging orchestrator decision:', error);
    }
  }

  // This is a placeholder for the actual implementation
  async extractAndStoreMemories(request: { userId: string; characterId: string; conversation: string; userPersona?: string | null; }): Promise<void> {
    logger.info({ message: 'Memory extraction triggered', ...request });
    // In the future, this will call the memory orchestrator LLM
    // and store the results in the database.
    const extractionResult = await this.extractMemories({
      user_id: request.userId,
      character_id: request.characterId,
      conversation: request.conversation.split('\n').map(line => {
        const [role, content] = line.split(': ');
        return { role, content } as ChatMessage;
      }),
      user_persona: request.userPersona ?? null
    });

    if (extractionResult.memories.length > 0) {
      await this.storeMemories(extractionResult.memories, request.userId, request.characterId);
    }
  }
}

export const memoryOrchestrator = MemoryOrchestrator.getInstance();

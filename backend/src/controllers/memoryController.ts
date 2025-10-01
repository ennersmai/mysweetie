import { Request, Response } from 'express';
import { fetchUserMemories, deleteUserMemory } from '../services/memoryService';
import { supabaseAdmin } from '../config/database';
import { logger } from '../utils/logger';
import { redis } from '../config/redis';

export const getMemories = async (req: Request, res: Response): Promise<void> => {
  try {
    // @ts-ignore
    const userId = req.user.id;
    const { characterId } = req.query;
    const conversationId = (req.query.conversationId as string) || '';

    if (!characterId || typeof characterId !== 'string') {
      res.status(400).json({ error: 'Invalid request. "characterId" query parameter is required.' });
      return;
    }

    logger.info({ message: 'Fetching memories', userId, characterId, conversationId });
    let { data, error } = await fetchUserMemories(userId, characterId);

    if (error) {
      res.status(500).json({ error: 'Failed to fetch user memories.' });
      return;
    }

    // If empty and a conversationId is provided, try to infer character_id from the conversation
    if ((Array.isArray(data) && data.length === 0) && conversationId) {
      const { data: conv, error: convErr } = await supabaseAdmin
        .from('conversations')
        .select('id, user_id, character_id')
        .eq('id', conversationId)
        .eq('user_id', userId)
        .maybeSingle();
      if (!convErr && conv?.character_id && conv.character_id !== characterId) {
        const retry = await fetchUserMemories(userId, conv.character_id);
        if (!retry.error) data = retry.data;
      }
    }

    // Prevent 304 caching to ensure fresh JSON is returned
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    logger.info({ message: 'Fetched memories result', count: Array.isArray(data) ? data.length : 0 });
    res.status(200).json(data ?? []);

  } catch (error: any) {
    logger.error({
      message: 'Error fetching user memories',
      error: error.message,
      stack: error.stack,
      path: 'memoryController.ts',
    });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const deleteMemory = async (req: Request, res: Response): Promise<void> => {
  try {
    // @ts-ignore
    const userId = req.user.id;
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ error: 'Memory ID is required.' });
      return;
    }

    const { error } = await deleteUserMemory(userId, id);

    if (error) {
      if (error.code === 'P2025') {
        res.status(404).json({ error: 'Memory not found or you do not have permission to delete it.' });
        return;
      }
      res.status(500).json({ error: 'Failed to delete memory.' });
      return;
    }

    res.status(204).send();

  } catch (error: any) {
    logger.error({
      message: 'Error deleting memory',
      error: error.message,
      stack: error.stack,
      path: 'memoryController.ts',
    });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const createMemory = async (req: Request, res: Response): Promise<void> => {
  try {
    // @ts-ignore
    const userId = req.user.id;
    const { characterId, memoryText, role } = req.body;

    if (!characterId || !memoryText) {
      res.status(400).json({ error: 'characterId and memoryText are required.' });
      return;
    }

    // Validate memory text length
    const trimmedText = (memoryText as string).trim();
    if (trimmedText.length === 0) {
      res.status(400).json({ error: 'Memory text cannot be empty.' });
      return;
    }

    if (trimmedText.length > 1000) {
      res.status(400).json({ error: 'Memory text is too long (max 1000 characters).' });
      return;
    }

    // Check memory limits
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('plan_tier, is_premium')
      .eq('id', userId)
      .maybeSingle();

    const planTier = profile?.plan_tier || (profile?.is_premium ? 'basic' : 'free');
    const memoryLimits: { [key: string]: number } = {
      'free': 20,
      'basic': 50,
      'premium': 100
    };
    const memoryLimit = memoryLimits[planTier] || 20;

    // Count current memories
    const { count } = await supabaseAdmin
      .from('user_memories')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('character_id', characterId === 'system' ? 'system' : characterId);

    const existingCount = count || 0;

    // If at limit, delete lowest importance memory to make room
    if (existingCount >= memoryLimit) {
      const { data: lowestMemory } = await supabaseAdmin
        .from('user_memories')
        .select('id')
        .eq('user_id', userId)
        .eq('character_id', characterId === 'system' ? 'system' : characterId)
        .order('importance_score', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (lowestMemory) {
        await supabaseAdmin
          .from('user_memories')
          .delete()
          .eq('id', lowestMemory.id);
        
        logger.info({ 
          message: 'Deleted low-importance memory to make room for pinned message', 
          userId, 
          characterId,
          memoryLimit 
        });
      }
    }

    // Create the memory
    const { data, error } = await supabaseAdmin
      .from('user_memories')
      .insert({
        user_id: userId,
        character_id: characterId === 'system' ? 'system' : characterId,
        memory_text: trimmedText,
        importance_score: 8, // High importance for manually pinned messages
        memory_type: role === 'user' ? 'factual' : 'relational',
        conversation_context: characterId === 'system' ? 'User profile memory' : `Pinned ${role} message`,
        last_accessed: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      logger.error({ message: 'Failed to create memory', error: error.message, userId, characterId });
      res.status(500).json({ error: 'Failed to create memory.' });
      return;
    }

    // Invalidate cache
    await redis.deleteCachedMemories(userId, characterId);

    logger.info({ 
      message: 'Memory created from pinned message', 
      userId, 
      characterId,
      memoryId: data.id,
      planTier 
    });

    res.status(201).json({ 
      message: 'Memory created successfully',
      memory: data 
    });

  } catch (error: any) {
    logger.error({
      message: 'Error creating memory',
      error: error.message,
      stack: error.stack,
      path: 'memoryController.ts',
    });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

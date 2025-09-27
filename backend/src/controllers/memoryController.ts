import { Request, Response } from 'express';
import { fetchUserMemories, deleteUserMemory } from '../services/memoryService';
import { supabaseAdmin } from '../config/database';
import { logger } from '../utils/logger';

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

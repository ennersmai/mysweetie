import { supabaseAdmin } from '../config/database';
import { logger } from '../utils/logger';
import { redis } from '../config/redis';

export const deleteConversation = async (userId: string, conversationId: string): Promise<{ success: boolean; error?: string }> => {
  try {
    // We need to delete from three tables in a specific order:
    // 1. chat_history
    // 2. user_memories
    // 3. conversations

    // First, verify the user owns the conversation
    const { data: conversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('id, character_id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      logger.warn({ message: 'User attempted to delete a conversation they do not own or that does not exist', userId, conversationId });
      return { success: false, error: 'Conversation not found or permission denied.' };
    }

    // Delete associated chat history
    const { error: historyError } = await supabaseAdmin
      .from('chat_history')
      .delete()
      .eq('conversation_id', conversationId);

    if (historyError) throw historyError;

    // Finally, delete the conversation itself
    const { error: finalConvError } = await supabaseAdmin
      .from('conversations')
      .delete()
      .eq('id', conversationId);

    if (finalConvError) throw finalConvError;

    // Note: We no longer delete user_memories when a conversation is removed.
    // If needed, cache invalidation can be handled when memories are updated.

    logger.info({ message: 'Successfully deleted conversation and associated data', userId, conversationId });
    return { success: true };

  } catch (error: any) {
    logger.error({
      message: 'Error deleting conversation',
      error: error.message,
      stack: error.stack,
      userId,
      conversationId,
    });
    return { success: false, error: 'An unexpected error occurred.' };
  }
};

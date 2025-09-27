import { logger } from '../utils/logger';

export async function fetchChatHistory(userId: string, conversationId: string) {
  logger.info({
    message: 'Service: Verifying conversation ownership',
    userId,
    conversationId,
  });
  // First, verify the user has access to this conversation
  const { data: conversationData, error: conversationError } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .single();

  if (conversationError || !conversationData) {
    logger.error({
      message: 'Service: Conversation not found or user does not have access',
      userId,
      conversationId,
      error: conversationError,
    });
    throw new Error('Conversation not found or user does not have access');
  }

  // Fetch messages for the conversation
  const { data: messagesData, error: messagesError } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (messagesError) {
    logger.error({
      message: 'Service: Failed to fetch messages',
      conversationId,
      error: messagesError,
    });
    throw new Error('Failed to fetch messages');
  }

  return {
    conversation: conversationData,
    messages: messagesData,
  };
}

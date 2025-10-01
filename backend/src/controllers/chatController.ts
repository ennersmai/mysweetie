import { Request, Response } from 'express';
import { processChat, fetchChatHistory } from '../services/chatService';
import { logger } from '../utils/logger';
import { supabaseAdmin } from '../config/database';

export const getChatHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { conversationId } = req.params;
    // @ts-ignore
    const userId = req.user.id;

    logger.info({
      message: 'Fetching chat history',
      userId,
      conversationId,
    });

    if (!conversationId) {
      res.status(400).json({ error: 'Conversation ID is required.' });
      return;
    }

    const history = await fetchChatHistory(userId, conversationId);

    if (history.error || !history.data) {
      // If the service returned a '404' code or data is null, send 404
      if (history.error?.code === '404' || !history.data) {
        res.status(404).json({ error: 'Chat history not found or you do not have permission to view it.' });
        return;
      }
      // For any other errors, send 500
      res.status(500).json({ error: 'Failed to fetch chat history.' });
      return;
    }

    // Set caching headers to prevent 304 Not Modified responses
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.status(200).json(history.data);
  } catch (error: any) {
    logger.error({
      message: 'Error fetching chat history',
      error: error.message,
      stack: error.stack,
      path: 'chatController.ts',
    });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const handleChat = async (req: Request, res: Response): Promise<void> => {
  try {
    // Basic validation
    const { character, messages, nsfwMode = false } = req.body;
    if (!character || !messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Invalid request body. "character" and "messages" are required.' });
      return;
    }

    // @ts-ignore
    const userId = req.user.id;

    // Stream the response back to the client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Immediately send headers

    for await (const chunk of processChat({ ...req.body, userId, nsfwMode })) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      // Force the data to be sent immediately
      if ((res as any).flush) {
        (res as any).flush();
      }
    }

    res.end();
  } catch (error: any) {
    logger.error({
      message: 'Error handling chat request',
      error: error.message,
      stack: error.stack,
      path: 'chatController.ts',
    });
    // Ensure response is not sent if headers are already sent
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    } else {
      res.end();
    }
  }
};

export const deleteChatMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { messageId } = req.params as { messageId: string };
    // @ts-ignore
    const userId = req.user.id as string;

    if (!messageId) {
      res.status(400).json({ error: 'Message ID is required.' });
      return;
    }

    const { data: msg, error: fetchErr } = await supabaseAdmin
      .from('chat_history')
      .select('id, user_id')
      .eq('id', messageId)
      .maybeSingle();

    if (fetchErr || !msg) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (msg.user_id !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const { error: delErr } = await supabaseAdmin
      .from('chat_history')
      .delete()
      .eq('id', messageId);

    if (delErr) {
      res.status(500).json({ error: 'Failed to delete message' });
      return;
    }
    res.status(204).end();
  } catch (error: any) {
    logger.error({ message: 'Error deleting chat message', error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const updateChatMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { messageId } = req.params as { messageId: string };
    const { content } = req.body as { content?: string };
    // @ts-ignore
    const userId = req.user.id as string;

    if (!messageId || typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'Message ID and non-empty content are required.' });
      return;
    }

    const { data: msg, error: fetchErr } = await supabaseAdmin
      .from('chat_history')
      .select('id, user_id, role')
      .eq('id', messageId)
      .maybeSingle();

    if (fetchErr || !msg) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (msg.user_id !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    // Allow editing both user and assistant messages
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      res.status(400).json({ error: 'Only user and assistant messages can be edited.' });
      return;
    }

    const { data, error: updErr } = await supabaseAdmin
      .from('chat_history')
      .update({ content })
      .eq('id', messageId)
      .select('id, role, content, created_at')
      .maybeSingle();

    if (updErr || !data) {
      res.status(500).json({ error: 'Failed to update message' });
      return;
    }
    res.status(200).json(data);
  } catch (error: any) {
    logger.error({ message: 'Error updating chat message', error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

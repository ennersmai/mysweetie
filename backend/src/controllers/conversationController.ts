import { Request, Response } from 'express';
import { deleteConversation } from '../services/conversationService';

export const handleDeleteConversation = async (req: Request, res: Response): Promise<void> => {
  // @ts-ignore
  const userId = req.user.id;
  const id = req.params['id'] as string;

  if (!id) {
    res.status(400).json({ error: 'Conversation ID is required.' });
    return;
  }

  const result = await deleteConversation(userId, id);

  if (result.success) {
    res.status(204).send(); // 204 No Content for successful deletion
  } else {
    res.status(404).json({ error: result.error || 'Failed to delete conversation.' });
  }
};

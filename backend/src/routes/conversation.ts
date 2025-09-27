import { Router } from 'express';
import { handleDeleteConversation } from '../controllers/conversationController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.delete('/:id', authenticate, handleDeleteConversation);

export default router;

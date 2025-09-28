import { Router } from 'express';
import { handleChat, getChatHistory, deleteChatMessage, updateChatMessage } from '../controllers/chatController';
import { authenticate } from '../middleware/auth';
import { chatLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/', authenticate, chatLimiter, handleChat);
router.get('/history/:conversationId', authenticate, getChatHistory);
router.delete('/message/:messageId', authenticate, deleteChatMessage);
router.put('/message/:messageId', authenticate, updateChatMessage);

export default router;

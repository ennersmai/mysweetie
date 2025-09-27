import { Router } from 'express';
import { handleChat, getChatHistory } from '../controllers/chatController';
import { authenticate } from '../middleware/auth';
import { chatLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/', authenticate, chatLimiter, handleChat);
router.get('/history/:conversationId', authenticate, getChatHistory);

export default router;

import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { handleArcanaPcm } from '../controllers/ttsController';

const router = Router();

// Authenticated PCM proxy to Arcana
router.post('/pcm', authenticate, handleArcanaPcm);

export default router;

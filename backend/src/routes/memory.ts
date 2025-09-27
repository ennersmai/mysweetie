import { Router } from 'express';
import { getMemories, deleteMemory } from '../controllers/memoryController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.get('/', authenticate, getMemories);
router.delete('/:id', authenticate, deleteMemory);

export default router;

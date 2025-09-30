import { Router } from 'express';
import { getMemories, deleteMemory, createMemory } from '../controllers/memoryController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.get('/', authenticate, getMemories);
router.post('/', authenticate, createMemory);
router.delete('/:id', authenticate, deleteMemory);

export default router;

import { Router } from 'express';
import { updateProfile } from '../controllers/userController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.put('/profile', authenticate, updateProfile);

export default router;

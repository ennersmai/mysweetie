/**
 * Call Routes
 * 
 * REST API routes for managing real-time voice call sessions
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { 
  initiateCall, 
  getCallStatus, 
  endCall 
} from '../controllers/callController';

const router = Router();

// All call routes require authentication
router.use(authenticate);

/**
 * POST /api/call/initiate
 * Initiate a new voice call session
 */
router.post('/initiate', initiateCall);

/**
 * GET /api/call/:sessionId/status
 * Get the status of an active call session
 */
router.get('/:sessionId/status', getCallStatus);

/**
 * POST /api/call/:sessionId/end
 * End an active call session
 */
router.post('/:sessionId/end', endCall);

export default router;

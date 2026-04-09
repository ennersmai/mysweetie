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

// Test endpoint to verify backend is running
const testBackend = async (req: any, res: any) => {
  res.json({ 
    status: 'ok', 
    message: 'Backend is running with latest code',
    timestamp: new Date().toISOString()
  });
};

const router = Router();

// Test endpoint (no auth required)
router.get('/test', testBackend);

// All other call routes require authentication
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

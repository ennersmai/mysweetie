/**
 * Stripe Routes
 * 
 * Payment processing and subscription management routes
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { 
  createCheckoutSession, 
  createPortalSession, 
  handleWebhook 
} from '../controllers/stripeController';

const router = Router();

/**
 * POST /api/stripe/create-checkout-session
 * Create a Stripe checkout session for subscription
 */
router.post('/create-checkout-session', authenticate, createCheckoutSession);

/**
 * POST /api/stripe/create-portal-session
 * Create a Stripe customer portal session
 */
router.post('/create-portal-session', authenticate, createPortalSession);

/**
 * POST /api/stripe/webhook
 * Handle Stripe webhooks (no auth required)
 */
router.post('/webhook', handleWebhook);

export default router;

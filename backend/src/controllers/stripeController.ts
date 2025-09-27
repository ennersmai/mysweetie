/**
 * Stripe Controller
 * 
 * Handles Stripe checkout sessions and customer portal management
 */

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { logger } from '../utils/logger';
import { supabaseAdmin } from '../config/database';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role?: string;
  };
}

// Make Stripe optional for development
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-08-27.basil',
}) : null;

const STRIPE_PRICE_IDS = {
  basic: process.env.STRIPE_BASIC_PRICE_ID || 'price_basic_monthly',
  premium: process.env.STRIPE_PREMIUM_PRICE_ID || 'price_premium_monthly',
  voice_credits: process.env.STRIPE_VOICE_CREDITS_PRICE_ID || 'price_voice_credits_200'
};

/**
 * Create Stripe Checkout Session
 */
export const createCheckoutSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Check if Stripe is configured
    if (!stripe) {
      res.status(503).json({ 
        error: 'Payment system not configured',
        message: 'Stripe is not available in development mode' 
      });
      return;
    }

    const { tier } = req.body;
    const userId = req.user?.id;
    const userEmail = req.user?.email;

    if (!userId || !userEmail) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!tier || !['basic', 'premium', 'voice_credits'].includes(tier)) {
      res.status(400).json({ error: 'Invalid tier. Must be "basic", "premium", or "voice_credits"' });
      return;
    }

    const priceId = STRIPE_PRICE_IDS[tier as keyof typeof STRIPE_PRICE_IDS];
    if (!priceId) {
      res.status(400).json({ error: `Price ID not configured for tier: ${tier}` });
      return;
    }

    // Check if user already has a Stripe customer ID
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    let customerId = profile?.stripe_customer_id;

    // Create customer if doesn't exist
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: {
          supabase_user_id: userId
        }
      });
      customerId = customer.id;

      // Save customer ID to profile
      await supabaseAdmin
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
    }

    // Create checkout session - different mode for voice credits vs subscriptions
    const isVoiceCredits = tier === 'voice_credits';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: isVoiceCredits ? 'payment' : 'subscription',
      success_url: `${process.env.FRONTEND_URL}/account?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: isVoiceCredits ? `${process.env.FRONTEND_URL}/account` : `${process.env.FRONTEND_URL}/subscribe`,
      metadata: {
        user_id: userId,
        tier: tier,
        ...(isVoiceCredits && { voice_credits: '200' })
      }
    });

    res.json({ url: session.url });

  } catch (error: any) {
    logger.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
};

/**
 * Create Stripe Customer Portal Session
 */
export const createPortalSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Check if Stripe is configured
    if (!stripe) {
      res.status(503).json({ 
        error: 'Payment system not configured',
        message: 'Stripe is not available in development mode' 
      });
      return;
    }

    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Get user's Stripe customer ID
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (error || !profile?.stripe_customer_id) {
      res.status(404).json({ error: 'No subscription found' });
      return;
    }

    // Create portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/account`,
    });

    res.json({ url: session.url });

  } catch (error: any) {
    logger.error('Error creating portal session:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
};

/**
 * Handle Stripe Webhooks
 */
export const handleWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    // Check if Stripe is configured
    if (!stripe) {
      logger.warn('Webhook received but Stripe not configured');
      res.status(503).json({ error: 'Stripe not configured' });
      return;
    }

    const signature = req.headers['stripe-signature'] as string;
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!endpointSecret) {
      logger.error('Stripe webhook secret not configured');
      res.status(500).json({ error: 'Webhook secret not configured' });
      return;
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(req.body, signature, endpointSecret);
    } catch (err: any) {
      logger.error('Webhook signature verification failed:', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      default:
        logger.info(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });

  } catch (error: any) {
    logger.error('Error handling webhook:', error);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
};

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  try {
    const userId = session.metadata?.user_id;
    const tier = session.metadata?.tier;
    const voiceCredits = session.metadata?.voice_credits;

    if (!userId) {
      logger.error('No user_id in checkout session metadata');
      return;
    }

    if (tier === 'voice_credits') {
      // Handle voice credits purchase
      const creditsToAdd = parseInt(voiceCredits || '200');
      
      // Add voice credits to user's account
      const { data: profile, error: fetchError } = await supabaseAdmin
        .from('profiles')
        .select('voice_credits')
        .eq('id', userId)
        .single();

      if (fetchError) {
        logger.error('Error fetching user profile for voice credits:', fetchError);
        return;
      }

      const currentCredits = profile?.voice_credits || 0;
      const newCredits = currentCredits + creditsToAdd;

      const { error } = await supabaseAdmin
        .from('profiles')
        .update({
          voice_credits: newCredits,
          stripe_customer_id: session.customer as string
        })
        .eq('id', userId);

      if (error) {
        logger.error('Error updating voice credits after purchase:', error);
      } else {
        logger.info(`User ${userId} purchased ${creditsToAdd} voice credits (total: ${newCredits})`);
      }
    } else {
      // Handle subscription purchase
      const { error } = await supabaseAdmin
        .from('profiles')
        .update({
          is_premium: true,
          plan_tier: tier || 'basic',
          subscription_id: session.subscription as string,
          stripe_customer_id: session.customer as string
        })
        .eq('id', userId);

      if (error) {
        logger.error('Error updating profile after checkout:', error);
      } else {
        logger.info(`User ${userId} upgraded to ${tier} plan`);
      }
    }

  } catch (error) {
    logger.error('Error in handleCheckoutCompleted:', error);
  }
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  try {
    const customerId = subscription.customer as string;
    const status = subscription.status;

    // Find user by customer ID
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .single();

    if (error || !profile) {
      logger.error('User not found for customer ID:', customerId);
      return;
    }

    // Update subscription status
    const isPremium = ['active', 'trialing'].includes(status);
    
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        is_premium: isPremium,
        subscription_id: subscription.id
      })
      .eq('id', profile.id);

    if (updateError) {
      logger.error('Error updating subscription status:', updateError);
    } else {
      logger.info(`Subscription ${subscription.id} updated to ${status} for user ${profile.id}`);
    }

  } catch (error) {
    logger.error('Error in handleSubscriptionUpdated:', error);
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  try {
    const customerId = subscription.customer as string;

    // Find user by customer ID
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .single();

    if (error || !profile) {
      logger.error('User not found for customer ID:', customerId);
      return;
    }

    // Downgrade user to free tier
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        is_premium: false,
        plan_tier: 'free',
        subscription_id: null
      })
      .eq('id', profile.id);

    if (updateError) {
      logger.error('Error downgrading user:', updateError);
    } else {
      logger.info(`User ${profile.id} downgraded to free tier`);
    }

  } catch (error) {
    logger.error('Error in handleSubscriptionDeleted:', error);
  }
}

async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  // Optional: Add logic for successful payments
  logger.info(`Payment succeeded for invoice ${invoice.id}`);
}

async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  try {
    // This handles one-time payments like voice credits
    // For voice credits, we already handle this in checkout.session.completed
    // This is a backup handler for additional payment intent events
    logger.info(`Payment intent succeeded: ${paymentIntent.id}`);
  } catch (error) {
    logger.error('Error in handlePaymentIntentSucceeded:', error);
  }
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  // Optional: Add logic for failed payments (retry logic, notifications, etc.)
  logger.warn(`Payment failed for invoice ${invoice.id}`);
}

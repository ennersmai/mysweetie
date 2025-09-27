import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/database';
import { logger } from '../utils/logger';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role?: string;
  };
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({ error: 'Access token required' });
      return;
    }

    // Verify the token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      // Optional dev-mode fallback when Supabase is unreachable
      const allowDevUnverified = process.env.ALLOW_DEV_UNVERIFIED_JWT === 'true' && process.env.NODE_ENV !== 'production';
      if (allowDevUnverified) {
        try {
          const decoded: any = jwt.decode(token);
          if (decoded && typeof decoded === 'object' && decoded.sub) {
            req.user = {
              id: decoded.sub,
              email: decoded.email || ''
            };
            logger.warn('Supabase auth unreachable; using unverified JWT (dev mode).');
            next();
            return;
          }
        } catch (e) {
          // fallthrough to 403
        }
      }
      logger.warn('Invalid token provided:', error?.message);
      res.status(403).json({ error: 'Invalid or expired token' });
      return;
    }

    // Attach user info to request
    req.user = {
      id: user.id,
      email: user.email || '',
      ...(user.role && { role: user.role })
    };

    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

export const requirePremium = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('is_premium, subscription_tier')
      .eq('id', req.user.id)
      .single();

    if (error) {
      logger.error('Error checking premium status:', error);
      res.status(500).json({ error: 'Failed to verify premium status' });
      return;
    }

    if (!profile?.is_premium) {
      res.status(403).json({ 
        error: 'Premium subscription required',
        upgradeRequired: true 
      });
      return;
    }

    next();
  } catch (error) {
    logger.error('Premium check error:', error);
    res.status(500).json({ error: 'Premium verification failed' });
  }
};

export const requireBasicPremium = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('is_premium, subscription_tier')
      .eq('id', req.user.id)
      .single();

    if (error) {
      logger.error('Error checking subscription status:', error);
      res.status(500).json({ error: 'Failed to verify subscription status' });
      return;
    }

    const tier = profile?.subscription_tier || 'free';
    if (tier === 'free') {
      res.status(403).json({ 
        error: 'Premium subscription required',
        upgradeRequired: true 
      });
      return;
    }

    next();
  } catch (error) {
    logger.error('Subscription check error:', error);
    res.status(500).json({ error: 'Subscription verification failed' });
  }
};

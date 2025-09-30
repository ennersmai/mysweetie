import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { logger } from '../utils/logger';

// General API rate limiter
export const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'), // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
  // Disable trust proxy validation for Fly.io
  validate: {
    trustProxy: false
  },
  handler: (req: Request, res: Response) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many requests from this IP, please try again later.',
      retryAfter: '15 minutes'
    });
  }
});

// Chat-specific rate limiter (more restrictive)
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // limit each IP to 20 chat requests per minute
  message: {
    error: 'Too many chat requests, please slow down.',
    retryAfter: '1 minute'
  },
  handler: (req: Request, res: Response) => {
    logger.warn(`Chat rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many chat requests, please slow down.',
      retryAfter: '1 minute'
    });
  }
});

// Voice synthesis rate limiter
export const voiceLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 voice requests per minute
  message: {
    error: 'Too many voice requests, please wait before requesting more.',
    retryAfter: '1 minute'
  },
  handler: (req: Request, res: Response) => {
    logger.warn(`Voice rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many voice requests, please wait before requesting more.',
      retryAfter: '1 minute'
    });
  }
});

// Memory extraction rate limiter
export const memoryLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 50, // limit each IP to 50 memory operations per 5 minutes
  message: {
    error: 'Too many memory operations, please wait.',
    retryAfter: '5 minutes'
  },
  handler: (req: Request, res: Response) => {
    logger.warn(`Memory rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many memory operations, please wait.',
      retryAfter: '5 minutes'
    });
  }
});

// Premium feature rate limiter (more lenient)
export const premiumLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 50, // Premium users get higher limits
  message: {
    error: 'Rate limit exceeded, please wait.',
    retryAfter: '1 minute'
  },
  handler: (req: Request, res: Response) => {
    logger.warn(`Premium rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Rate limit exceeded, please wait.',
      retryAfter: '1 minute'
    });
  }
});

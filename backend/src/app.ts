import dotenv from 'dotenv';

// Load environment variables FIRST
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import path from 'path';
import { logger } from './utils/logger';
import { generalLimiter } from './middleware/rateLimiter';
import { testConnection } from './config/database';
import { redis } from './config/redis';
import chatRoutes from './routes/chat';
import userRoutes from './routes/user';
import memoryRoutes from './routes/memory';
import ttsRoutes from './routes/tts';
import conversationRoutes from './routes/conversation';
import callRoutes from './routes/call';
import stripeRoutes from './routes/stripe';
import { authenticate } from './middleware/auth';

// Initialize configurations
const app = express();

// Trust proxy for Fly.io (required for rate limiting to work correctly)
// Use specific proxy configuration for Fly.io instead of trusting all proxies
app.set('trust proxy', 1);

testConnection();
redis.connect();

// CORS configuration - Should be one of the first middleware
function buildAllowedOrigins(): string[] {
  const defaults = ['http://localhost:5173', 'http://localhost:3000'];
  const fromEnv = `${process.env.CORS_ORIGIN || ''},${process.env.CORS_ORIGINS || ''}`
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const explicit = process.env.PUBLIC_WEB_ORIGIN ? [process.env.PUBLIC_WEB_ORIGIN] : [];
  return Array.from(new Set([...defaults, ...fromEnv, ...explicit]));
}

const allowedOrigins = buildAllowedOrigins();

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow non-browser requests (no origin) e.g. curl, server-to-server
    if (!origin) return callback(null, true);
    const o = origin.toLowerCase();
    const isAllowed =
      allowedOrigins.some(a => a.toLowerCase() === o) ||
      // Allow all Vercel preview deployments
      o.endsWith('.vercel.app') ||
      // Allow localhost variations
      o.startsWith('http://localhost:');

    if (isAllowed) return callback(null, true);
    return callback(new Error(`CORS not allowed for origin: ${origin}`));
  },
  credentials: process.env.CORS_CREDENTIALS ? process.env.CORS_CREDENTIALS === 'true' : true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};

app.use(cors(corsOptions));

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      // Allow both http and https for dev/prod APIs; and ws/wss for realtime
      connectSrc: ["'self'", "http:", "https:", "ws:", "wss:"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "blob:"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Compression middleware
app.use(compression());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('combined', {
    stream: {
      write: (message: string) => logger.info(message.trim())
    }
  }));
} else {
  app.use(morgan('dev'));
}

// Rate limiting
app.use(generalLimiter);

// API routes
app.use('/api/chat', authenticate, chatRoutes);
app.use('/api/user', userRoutes);
app.use('/api/memories', authenticate, memoryRoutes);
app.use('/api/tts', ttsRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/call', callRoutes);
app.use('/api/stripe', stripeRoutes);

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const dbConnected = await testConnection();
    const redisConnected = redis.isConnected();
    
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbConnected ? 'connected' : 'disconnected',
      redis: redisConnected ? 'connected' : 'disconnected',
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        external: Math.round(process.memoryUsage().external / 1024 / 1024),
      },
      environment: process.env.NODE_ENV || 'development'
    };

    if (!dbConnected || !redisConnected) {
      res.status(503).json(health);
    } else {
      res.json(health);
    }
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'error',
      message: 'Health check failed'
    });
  }
});

// Default API route
app.get('/', (req, res) => {
  res.json({
    message: 'MySweetie.AI Backend API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    features: {
      memorySystem: 'enabled',
      nsfwMode: process.env.NSFW_JAILBREAK_ENABLED === 'true',
      voiceSupport: 'enabled',
      realTimeVoice: 'enabled',
      premiumFeatures: 'enabled'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    message: `${req.method} ${req.originalUrl} is not a valid endpoint`,
    availableEndpoints: [
      `GET /`,
      'GET /health'
    ]
  });
});

// Global error handler
app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip
  });

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
    timestamp: new Date().toISOString()
  });
});

export default app;

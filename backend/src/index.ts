import app from './app';
import { logger } from './utils/logger';
import { createServer } from 'http';
import { handleWebSocketUpgrade } from './controllers/callController';

const port = process.env.PORT || 3001;
const host = process.env.HOST || '0.0.0.0'; // Listen on all interfaces (required for Fly.io)

// Create an HTTP server so we can attach WebSocket upgrade handling
const server = createServer(app);

// Set up WebSocket handling for real-time voice calls
handleWebSocketUpgrade(server);

server.listen(Number(port), host, () => {
  console.log(`🚀 MySweetie.AI Backend Server running on ${host}:${port}`);
  console.log(`🎤 Real-time voice calls available at ws://localhost:${port}/ws/call/{sessionId}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`);
  console.log(`🌍 Frontend URL: ${process.env.FRONTEND_URL || 'Not set'}`);
  console.log(`📊 Log level: ${process.env.LOG_LEVEL || 'info'}`);
  
  logger.info(`🚀 MySweetie.AI Backend Server running on ${host}:${port}`);
  logger.info(`🎤 Real-time voice calls available at ws://localhost:${port}/ws/call/{sessionId}`);
  logger.info(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`🔑 Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`);
  logger.info(`🌍 Frontend URL: ${process.env.FRONTEND_URL || 'Not set'}`);
  logger.info(`📊 Log level: ${process.env.LOG_LEVEL || 'info'}`);
});

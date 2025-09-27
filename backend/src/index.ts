import app from './app';
import { logger } from './utils/logger';
import { createServer } from 'http';
import { handleWebSocketUpgrade } from './controllers/callController';

const port = process.env.PORT || 3001;

// Create an HTTP server so we can attach WebSocket upgrade handling
const server = createServer(app);

// Set up WebSocket handling for real-time voice calls
handleWebSocketUpgrade(server);

server.listen(port, () => {
  logger.info(`🚀 MySweetie.AI Backend Server running on port ${port}`);
  logger.info(`🎤 Real-time voice calls available at ws://localhost:${port}/ws/call/{sessionId}`);
});

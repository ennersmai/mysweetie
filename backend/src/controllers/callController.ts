/**
 * Call Controller
 * 
 * Manages WebSocket connections for real-time voice conversations.
 * Handles session lifecycle and routes audio data to the call service.
 */

import { Request, Response } from 'express';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { callService, CallState } from '../services/callService';
import { logger } from '../utils/logger';
import { supabaseAdmin } from '../config/database';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role?: string;
  };
}

export interface CallInitiationRequest {
  characterId: string;
  conversationId?: string;
}

/**
 * Initiate a new voice call session
 */
export const initiateCall = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { characterId, conversationId } = req.body as CallInitiationRequest;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!characterId) {
      res.status(400).json({ error: 'Character ID is required' });
      return;
    }

    // Fetch character details
    const { data: character, error: characterError } = await supabaseAdmin
      .from('characters')
      .select('*')
      .eq('id', characterId)
      .single();

    if (characterError || !character) {
      res.status(404).json({ error: 'Character not found' });
      return;
    }

    // Create or get conversation ID
    let finalConversationId = conversationId;
    if (!finalConversationId) {
      const { data: conversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .insert({
          id: uuidv4(),
          user_id: userId,
          character_id: characterId,
          title: `Voice call with ${character.name}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (convError || !conversation) {
        logger.error('Error creating conversation:', convError);
        res.status(500).json({ error: 'Failed to create conversation' });
        return;
      }

      finalConversationId = conversation.id;
    }

    // Generate session ID for WebSocket connection
    const sessionId = uuidv4();

    res.json({
      sessionId,
      conversationId: finalConversationId,
      character: {
        id: character.id,
        name: character.name,
        avatar_url: character.avatar_url
      },
      wsUrl: `/ws/call/${sessionId}`
    });

    logger.info(`Call initiation successful: session ${sessionId}, user ${userId}, character ${characterId}`);

  } catch (error: any) {
    logger.error('Error initiating call:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get active call session status
 */
export const getCallStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!sessionId) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    const session = callService.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (session.userId !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({
      sessionId: session.id,
      state: session.state,
      isActive: session.isActive,
      duration: Date.now() - session.startTime,
      conversationId: session.conversationId
    });

  } catch (error: any) {
    logger.error('Error getting call status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * End an active call session
 */
export const endCall = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!sessionId) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    const session = callService.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (session.userId !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    callService.endSession(sessionId);

    res.json({ 
      message: 'Call ended successfully',
      duration: Date.now() - session.startTime
    });

    logger.info(`Call ended: session ${sessionId}, user ${userId}`);

  } catch (error: any) {
    logger.error('Error ending call:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Handle WebSocket upgrade for call sessions
 */
export const handleWebSocketUpgrade = (server: any): void => {
  const wss = new WebSocket.Server({ 
    noServer: true
  });

  server.on('upgrade', (request: any, socket: any, head: any) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const path = url.pathname;
    
    // Only handle calls to /ws/call/
    if (path.startsWith('/ws/call/')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket, req) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const sessionId = url.pathname.split('/')[3];

    if (!sessionId) {
      logger.warn('WebSocket connection without session ID');
      ws.close(1008, 'Session ID required');
      return;
    }

    try {
      // Extract auth token from query params or headers
      const token = url.searchParams.get('token') || req.headers.authorization?.split(' ')[1];
      
      if (!token) {
        logger.warn(`WebSocket connection without auth token: ${sessionId}`);
        ws.close(1008, 'Authentication required');
        return;
      }

      // Verify token and get user info
      const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
      
      if (error || !user) {
        logger.warn(`WebSocket connection with invalid token: ${sessionId}`);
        ws.close(1008, 'Invalid authentication');
        return;
      }

      logger.info(`WebSocket connected: session ${sessionId}, user ${user.id}`);

      // For this demo, we'll create a default session
      // In production, you'd want to validate the session was properly initiated
      const { data: character } = await supabaseAdmin
        .from('characters')
        .select('*')
        .limit(1)
        .single();

      if (!character) {
        ws.close(1008, 'No characters available');
        return;
      }

      // Create the call session
      const session = callService.createSession(
        sessionId,
        user.id,
        character.id,
        character,
        'temp-conversation-id', // This should come from session initiation
        ws
      );

      // Handle binary audio data from client
      ws.on('message', async (data) => {
        if (data instanceof Buffer) {
          // Binary audio data
          await callService.processAudioData(sessionId, data);
        } else {
          // JSON messages (for future extensions)
          try {
            const message = JSON.parse(data.toString());
            logger.debug(`Received message from client:`, message);
            
            // Handle control messages if needed
            if (message.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong' }));
            } else if (message.type === 'force_end_speech') {
              // Manually trigger end of speech
              const session = callService.getSession(sessionId);
              if (session && session.state === 'USER_SPEAKING') {
                logger.info(`Manual speech end triggered for session ${sessionId}`);
                // Force transition to AI processing
                await callService.forceTransitionToAIProcessing(sessionId);
              }
            } else if (message.type === 'interrupt') {
              // Manual interruption
              const session = callService.getSession(sessionId);
              if (session) {
                logger.info(`Manual interruption triggered for session ${sessionId}`);
                await callService.forceInterruption(sessionId);
              }
            }
          } catch (error) {
            logger.warn('Invalid JSON message from client:', data.toString());
          }
        }
      });

      ws.on('close', (code, reason) => {
        logger.info(`WebSocket disconnected: session ${sessionId}, code ${code}, reason: ${reason}`);
        callService.endSession(sessionId);
      });

      ws.on('error', (error) => {
        logger.error(`WebSocket error for session ${sessionId}:`, error);
        callService.endSession(sessionId);
      });

    } catch (error: any) {
      logger.error('Error setting up WebSocket connection:', error);
      ws.close(1011, 'Server error');
    }
  });

  logger.info('WebSocket server initialized for call sessions');
};

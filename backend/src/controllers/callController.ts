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
  nsfwMode?: boolean;
}

/**
 * Initiate a new voice call session
 */
export const initiateCall = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { characterId, conversationId, nsfwMode } = req.body as CallInitiationRequest;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!characterId) {
      res.status(400).json({ error: 'Character ID is required' });
      return;
    }

    // Check voice credits before allowing call
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('voice_credits')
      .eq('id', userId)
      .maybeSingle();
    if (profileErr || !profile) {
      res.status(500).json({ error: 'Failed to verify credits' });
      return;
    }
    if ((profile.voice_credits ?? 0) <= 0) {
      res.status(402).json({ error: 'INSUFFICIENT_CREDITS', message: 'Not enough voice credits to start a call.' });
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
    const queryCharacterId = url.searchParams.get('characterId') || undefined;
    const queryConversationId = url.searchParams.get('conversationId') || undefined;
    const queryVoice = url.searchParams.get('voice') || undefined;

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

      // Fetch the intended character using query param if provided; fall back to any available character
      let characterRecord: any | null = null;
      if (queryCharacterId) {
        const { data: c, error: ce } = await supabaseAdmin
          .from('characters')
          .select('*')
          .eq('id', queryCharacterId)
          .maybeSingle();
        if (ce) {
          logger.warn('Character fetch error:', ce);
        }
        characterRecord = c || null;
      }
      if (!characterRecord) {
        const { data: character } = await supabaseAdmin
          .from('characters')
          .select('*')
          .limit(1)
          .single();
        characterRecord = character || null;
      }

      if (!characterRecord) {
        ws.close(1008, 'No characters available');
        return;
      }

      // Determine conversation id: use query if provided; otherwise reuse/initiate one for this user+character
      let finalConversationId: string = queryConversationId || '';
      if (!finalConversationId) {
        // Try find the most recent conversation for this user+character
        const { data: conv } = await supabaseAdmin
          .from('conversations')
          .select('id')
          .eq('user_id', user.id)
          .eq('character_id', characterRecord.id)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        finalConversationId = (conv?.id || `voice-${sessionId}`);
      }

      const session = callService.createSession(
        sessionId,
        user.id,
        characterRecord.id,
        { ...characterRecord, voice: queryVoice || characterRecord.voice },
        finalConversationId,
        ws,
        false
      );

      // Handle messages from client (audio and JSON control)
      ws.on('message', async (data: WebSocket.Data, isBinary: boolean) => {
        try {
          logger.info(`[WEBSOCKET] ===== MESSAGE RECEIVED =====`);
          logger.info(`[WEBSOCKET] Session: ${sessionId}`);
          logger.info(`[WEBSOCKET] isBinary: ${isBinary}`);
          const dataLen = ((): number => {
            if (typeof data === 'string') return data.length;
            if (Buffer.isBuffer(data)) return data.length;
            if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).length;
            if (data instanceof ArrayBuffer) return data.byteLength;
            // Node types: Buffer, ArrayBuffer, string, Array<Buffer>
            return 0;
          })();
          logger.info(`[WEBSOCKET] Data length: ${dataLen}`);

          if (isBinary) {
            // Binary audio data
            const audioBuffer: Buffer = Array.isArray(data)
              ? Buffer.concat(data as Buffer[])
              : Buffer.isBuffer(data)
                ? data
                : Buffer.from(data as ArrayBuffer);
            logger.debug(`Received binary audio data: ${audioBuffer.length} bytes`);
            await callService.processAudioData(sessionId, audioBuffer);
            return;
          }

          // Text message (may still come as Buffer in some cases)
          const rawMessage = (typeof data === 'string') ? data : (data as Buffer).toString('utf8');
          logger.info(`[WEBSOCKET] ===== INCOMING JSON MESSAGE =====`);
          logger.info(`[WEBSOCKET] Session: ${sessionId}`);
          logger.info(`[WEBSOCKET] Raw: ${rawMessage}`);

          let message: any;
          try {
            message = JSON.parse(rawMessage);
          } catch (e) {
            logger.warn(`[WEBSOCKET] Non-JSON text message from ${sessionId}, ignoring.`);
            return;
          }

          logger.info(`[WEBSOCKET] Parsed:`, JSON.stringify(message, null, 2));
          logger.info(`[WEBSOCKET] Type: "${message.type}"`);
          logger.info(`[WEBSOCKET] ===================================`);

          if (message.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }

          if (message.type === 'force_end_speech') {
            const session = callService.getSession(sessionId);
            if (session && session.state === CallState.USER_SPEAKING) {
              logger.info(`Manual speech end triggered for session ${sessionId}`);
              await callService.forceTransitionToAIProcessing(sessionId);
            }
            return;
          }

          if (message.type === 'interrupt') {
            const session = callService.getSession(sessionId);
            if (session) {
              logger.info(`Manual interruption triggered for session ${sessionId}`);
              await callService.forceInterruption(sessionId);
            }
            return;
          }

          if (message.type === 'tts_playback_finished') {
            logger.info(`[BACKEND] Received tts_playback_finished message for session ${sessionId}`);
            const session = callService.getSession(sessionId);
            if (session) {
              logger.info(`[BACKEND] TTS playback finished for session ${sessionId}, current state: ${session.state}, isTTSStreamingComplete: ${session.isTTSStreamingComplete}`);
              await callService.handleTTSPlaybackFinished(sessionId);
              const updatedSession = callService.getSession(sessionId);
              if (updatedSession) {
                logger.info(`[BACKEND] After handling TTS playback finished - new state: ${updatedSession.state}`);
              }
            } else {
              logger.warn(`Session ${sessionId} not found when processing tts_playback_finished`);
            }
            return;
          }

          logger.warn(`[WEBSOCKET] Unknown message type from ${sessionId}: ${message.type}`);
        } catch (error) {
          logger.error(`[WEBSOCKET] Error handling message for ${sessionId}:`, error);
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

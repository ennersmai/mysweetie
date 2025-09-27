/**
 * Real-Time Call Service
 * 
 * Core orchestrator for real-time voice conversations. Manages state transitions,
 * VAD processing, and coordinates with Groq (ASR) and Rime.ai (TTS) services.
 */

import WebSocket from 'ws';
import axios from 'axios';
import FormData from 'form-data';
import { VoiceActivityDetector, createVAD } from '../utils/vad';
import { logger } from '../utils/logger';
import { processChat } from './chatService';

export enum CallState {
  IDLE = 'IDLE',
  USER_SPEAKING = 'USER_SPEAKING', 
  AI_PROCESSING = 'AI_PROCESSING',
  AI_SPEAKING = 'AI_SPEAKING'
}

export interface CallSession {
  id: string;
  userId: string;
  characterId: string;
  character: any;
  state: CallState;
  conversationId: string;
  clientWebSocket: WebSocket;
  vad: VoiceActivityDetector;
  audioBuffer: Buffer[];
  transcriptBuffer: string;
  isActive: boolean;
  startTime: number;
}

export interface CallMessage {
  type: 'command' | 'transcript_update' | 'state_change' | 'error' | 'ai_response';
  command?: string;
  text?: string;
  is_final?: boolean;
  state?: CallState;
  error?: string;
}

export class CallService {
  private sessions: Map<string, CallSession> = new Map();
  private readonly GROQ_API_KEY = process.env.GROQ_API_KEY;
  private readonly RIME_API_KEY = process.env.RIME_API_KEY;
  private readonly GROQ_HTTP_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
  private readonly RIME_HTTP_URL = 'https://users.rime.ai/v1/rime-tts';

  constructor() {
    if (!this.GROQ_API_KEY) {
      logger.error('GROQ_API_KEY environment variable is required');
    }
    if (!this.RIME_API_KEY) {
      logger.error('RIME_API_KEY environment variable is required');
    }
  }

  /**
   * Create a new call session
   */
  public createSession(
    sessionId: string,
    userId: string,
    characterId: string,
    character: any,
    conversationId: string,
    clientWebSocket: WebSocket
  ): CallSession {
    const session: CallSession = {
      id: sessionId,
      userId,
      characterId,
      character,
      state: CallState.IDLE,
      conversationId,
      clientWebSocket,
      vad: createVAD({
        sampleRate: 48000, // Match browser sample rate
        frameSize: 2048, // Larger frame for 48kHz
        energyThreshold: 0.003, // Even more sensitive
        silenceFrames: 45, // ~1.5 seconds of silence to end speech (give more time)
        voiceFrames: 3 // ~125ms to start speech (keep sensitive)
      }),
      audioBuffer: [],
      transcriptBuffer: '',
      isActive: true,
      startTime: Date.now()
    };

    this.sessions.set(sessionId, session);

    // Set up client WebSocket event handlers
    this.setupClientWebSocket(session);

    logger.info(`Call session created: ${sessionId} for user ${userId}`);
    return session;
  }

  /**
   * Process incoming audio data from client
   */
  public async processAudioData(sessionId: string, audioData: Buffer): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) {
      return;
    }

    try {
      // Run VAD on the audio chunk
      const vadResult = session.vad.processAudio(audioData);

      // Handle state transitions based on VAD
      await this.handleVADResult(session, vadResult, audioData);

    } catch (error: any) {
      logger.error('Error processing audio data:', error);
      this.sendErrorToClient(session, 'Audio processing failed');
    }
  }

  /**
   * End a call session
   */
  public endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.isActive = false;
    this.sessions.delete(sessionId);
    
    const duration = Date.now() - session.startTime;
    logger.info(`Call session ended: ${sessionId}, duration: ${duration}ms`);
  }

  /**
   * Get session by ID
   */
  public getSession(sessionId: string): CallSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Force transition to AI processing (manual speech end)
   */
  public async forceTransitionToAIProcessing(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && session.state === CallState.USER_SPEAKING) {
      await this.transitionToAIProcessing(session);
    }
  }

  /**
   * Force interruption (manual interrupt)
   */
  public async forceInterruption(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await this.handleInterruption(session);
    }
  }

  private setupClientWebSocket(session: CallSession): void {
    session.clientWebSocket.on('close', () => {
      logger.info(`Client WebSocket closed for session ${session.id}`);
      this.endSession(session.id);
    });

    session.clientWebSocket.on('error', (error) => {
      logger.error(`Client WebSocket error for session ${session.id}:`, error);
      this.endSession(session.id);
    });
  }

  private async handleVADResult(
    session: CallSession, 
    vadResult: any, 
    audioData: Buffer
  ): Promise<void> {
    const wasSpeak = session.state === CallState.USER_SPEAKING;
    const isSpeak = vadResult.isVoice;

    // State transition: IDLE/AI_SPEAKING -> USER_SPEAKING
    if (!wasSpeak && isSpeak && (session.state === CallState.IDLE || session.state === CallState.AI_SPEAKING)) {
      await this.transitionToUserSpeaking(session);
    }

    // State transition: USER_SPEAKING -> AI_PROCESSING
    if (wasSpeak && !isSpeak && session.state === CallState.USER_SPEAKING) {
      await this.transitionToAIProcessing(session);
    }

    // Handle audio buffering during speech
    if (session.state === CallState.USER_SPEAKING) {
      session.audioBuffer.push(audioData);
      // Log every 10th audio chunk to avoid spam
      if (session.audioBuffer.length % 10 === 0) {
        logger.debug(`Audio buffer now has ${session.audioBuffer.length} chunks (${audioData.length} bytes latest)`);
      }
    }

    // Handle interruption during AI speaking
    if (session.state === CallState.AI_SPEAKING && isSpeak) {
      await this.handleInterruption(session);
    }
  }

  private async transitionToUserSpeaking(session: CallSession): Promise<void> {
    logger.info(`Session ${session.id}: Transitioning to USER_SPEAKING`);
    
    // If AI was speaking, stop it immediately
    if (session.state === CallState.AI_SPEAKING) {
      await this.handleInterruption(session);
    }

    session.state = CallState.USER_SPEAKING;
    session.audioBuffer = [];
    session.transcriptBuffer = '';
    
    this.sendStateUpdate(session, CallState.USER_SPEAKING);
  }

  private async transitionToAIProcessing(session: CallSession): Promise<void> {
    logger.info(`Session ${session.id}: Transitioning to AI_PROCESSING`);
    
    session.state = CallState.AI_PROCESSING;
    this.sendStateUpdate(session, CallState.AI_PROCESSING);

    logger.info(`About to process audio with Groq for session ${session.id}`);
    
    // Process the buffered audio with Groq HTTP API
    try {
      await this.processAudioWithGroq(session);
    } catch (error: any) {
      logger.error(`Failed to process audio for session ${session.id}:`, error);
      // Fallback to continue the conversation
      this.generateAIResponse(session, 'I had trouble hearing you, but let me respond anyway!');
    }
  }

  private async transitionToAISpeaking(session: CallSession, responseText: string): Promise<void> {
    logger.info(`Session ${session.id}: Transitioning to AI_SPEAKING`);
    
    session.state = CallState.AI_SPEAKING;
    this.sendStateUpdate(session, CallState.AI_SPEAKING);

    // Open connection to Rime.ai for TTS
    await this.openRimeConnection(session, responseText);
  }

  private async handleInterruption(session: CallSession): Promise<void> {
    logger.info(`Session ${session.id}: Handling interruption`);

    // Send stop playback command to client
    this.sendCommandToClient(session, 'stop_playback');

    // Reset VAD state
    session.vad.reset();
  }

  private async processAudioWithGroq(session: CallSession): Promise<void> {
    try {
      // Check if Groq API key is available
      if (!this.GROQ_API_KEY) {
        logger.warn('GROQ_API_KEY not configured, using fallback transcript');
        // Generate AI response with fallback text
        this.generateAIResponse(session, 'Hello, this is a test message from the voice call system.');
        return;
      }

      // Combine all audio buffers into a single audio file
      const audioData = Buffer.concat(session.audioBuffer);
      
      logger.info(`Audio buffer info for session ${session.id}: ${session.audioBuffer.length} chunks, total ${audioData.length} bytes`);
      
      if (audioData.length === 0) {
        logger.warn(`No audio data for session ${session.id}`);
        this.generateAIResponse(session, 'I didn\'t hear anything. Could you please repeat?');
        return;
      }

      if (audioData.length < 1000) {
        logger.warn(`Very short audio for session ${session.id}: ${audioData.length} bytes`);
        this.generateAIResponse(session, 'That was very brief. Could you speak a bit longer?');
        return;
      }

      logger.info(`Processing ${audioData.length} bytes of audio for session ${session.id}`);

      // Convert PCM to WAV format for Groq API
      // Calculate sample rate based on audio data (assuming 16-bit mono)
      const estimatedDurationMs = (audioData.length / 2) / 48000 * 1000; // Assume 48kHz
      logger.info(`Estimated audio duration: ${estimatedDurationMs.toFixed(0)}ms`);
      
      const wavBuffer = this.pcmToWav(audioData, 48000, 1);

      // Create form data for Groq API
      const form = new FormData();
      form.append('file', wavBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav'
      });
      form.append('model', 'whisper-large-v3-turbo');
      form.append('language', 'en');
      form.append('response_format', 'json');
      form.append('temperature', '0');

      // Send to Groq API
      const response = await axios.post(this.GROQ_HTTP_URL, form, {
        headers: {
          'Authorization': `Bearer ${this.GROQ_API_KEY}`,
          ...form.getHeaders()
        },
        timeout: 10000
      });

      const transcript = response.data.text;
      logger.info(`Groq transcription for session ${session.id}: "${transcript}"`);

      if (transcript && transcript.trim()) {
        // Send transcript to client
        this.sendTranscriptUpdate(session, transcript, true);
        
        // Generate AI response
        this.generateAIResponse(session, transcript);
      } else {
        logger.warn(`Empty transcript for session ${session.id}`);
        this.generateAIResponse(session, 'I didn\'t catch that. Could you please repeat?');
      }

    } catch (error: any) {
      logger.error(`Error processing audio with Groq for session ${session.id}:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        stack: error.stack
      });
      
      // Use fallback transcript so the flow continues
      logger.info(`Using fallback transcript for session ${session.id}`);
      this.generateAIResponse(session, 'I heard you speaking but had trouble processing the audio. Let me respond anyway!');
    }
  }

  private pcmToWav(pcmBuffer: Buffer, sampleRate: number, channels: number): Buffer {
    const length = pcmBuffer.length;
    const arrayBuffer = new ArrayBuffer(44 + length);
    const view = new DataView(arrayBuffer);

    // WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length, true);

    // Copy PCM data
    const wavBuffer = Buffer.from(arrayBuffer);
    pcmBuffer.copy(wavBuffer, 44);

    return wavBuffer;
  }

  private async openRimeConnection(session: CallSession, text: string): Promise<void> {
    try {
      // Check if Rime API key is available
      if (!this.RIME_API_KEY) {
        logger.warn('RIME_API_KEY not configured, skipping TTS');
        // Just return to idle state without audio
        setTimeout(() => {
          session.state = CallState.IDLE;
          this.sendStateUpdate(session, CallState.IDLE);
        }, 500);
        return;
      }

      logger.info(`Starting TTS for session ${session.id} with text: "${text}"`);

      // Use the same payload structure as the existing TTS controller
      const payload = {
        speaker: 'mabel',
        text: text,
        modelId: 'arcana',
        repetition_penalty: 1.5,
        temperature: 0.5,
        top_p: 1,
        samplingRate: 24000,
        max_tokens: 1200
      };

      // Debug API key (without revealing it)
      logger.info(`Rime API key loaded: ${this.RIME_API_KEY ? 'YES' : 'NO'}, length: ${this.RIME_API_KEY?.length || 0}`);
      
      const headers = {
        'Accept': 'audio/pcm',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.RIME_API_KEY}`,
      };
      
      // Debug the actual authorization header (first 20 chars only)
      logger.info(`Authorization header preview: "${headers.Authorization?.substring(0, 20)}..."`);
      logger.info(`API key first 10 chars: "${this.RIME_API_KEY?.substring(0, 10)}"`);
      logger.info(`API key last 5 chars: "${this.RIME_API_KEY?.substring(this.RIME_API_KEY.length - 5)}"`);
      logger.info(`API key contains spaces: ${this.RIME_API_KEY?.includes(' ')}`);
      
      logger.info(`Rime request headers:`, headers);
      logger.info(`Rime request payload:`, payload);
      logger.info(`Rime request URL:`, this.RIME_HTTP_URL);
      
      // Make HTTP request to Rime.ai
      const response = await axios({
        method: 'POST',
        url: this.RIME_HTTP_URL,
        headers,
        data: JSON.stringify(payload),
        responseType: 'stream',
        validateStatus: () => true,
        maxBodyLength: Infinity,
        timeout: 30000
      });

      if (response.status !== 200) {
        let errText = '';
        try {
          const chunks: Buffer[] = [];
          response.data.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.data.on('end', () => {
            errText = Buffer.concat(chunks).toString('utf8');
          });
          await new Promise(resolve => response.data.on('end', resolve));
        } catch (e) {
          errText = 'Failed to read error response';
        }
        
        logger.error(`Rime TTS error for session ${session.id}:`, {
          status: response.status,
          statusText: response.statusText,
          body: errText.slice(0, 500)
        });
        
        // Fallback to idle state
        session.state = CallState.IDLE;
        this.sendStateUpdate(session, CallState.IDLE);
        return;
      }

      logger.info(`Rime TTS started for session ${session.id}, streaming audio to client`);

      // Stream PCM audio data to client
      response.data.on('data', (chunk: Buffer) => {
        if (session.clientWebSocket.readyState === WebSocket.OPEN) {
          session.clientWebSocket.send(chunk);
        }
      });

      response.data.on('end', () => {
        logger.info(`Rime TTS completed for session ${session.id}`);
        // Wait a bit for audio to finish playing before returning to idle
        setTimeout(() => {
          if (session.isActive && session.state === CallState.AI_SPEAKING) {
            session.state = CallState.IDLE;
            this.sendStateUpdate(session, CallState.IDLE);
            logger.info(`Session ${session.id} returned to IDLE after TTS completion`);
          }
        }, 1000); // Give 1 second for audio to finish playing
      });

      response.data.on('error', (error: any) => {
        logger.error(`Rime TTS stream error for session ${session.id}:`, error);
        // Fallback to idle state
        session.state = CallState.IDLE;
        this.sendStateUpdate(session, CallState.IDLE);
      });

    } catch (error: any) {
      logger.error(`Error with Rime TTS for session ${session.id}:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        stack: error.stack
      });
      
      // Fallback to idle state
      session.state = CallState.IDLE;
      this.sendStateUpdate(session, CallState.IDLE);
    }
  }

  private handleGroqMessage(session: CallSession, message: any): void {
    try {
      if (message.result) {
        const { type, text } = message.result;
        
        // Send interim transcripts to client for real-time display
        if (type === 'interim' && text) {
          this.sendTranscriptUpdate(session, text, false);
        }
        
        // Handle final transcript
        if (type === 'final' && text) {
          session.transcriptBuffer = text;
          this.sendTranscriptUpdate(session, text, true);
          
          // Generate AI response
          this.generateAIResponse(session, text);
        }
      }
    } catch (error: any) {
      logger.error('Error handling Groq message:', error);
    }
  }

  private async generateAIResponse(session: CallSession, userMessage: string): Promise<void> {
    try {
      // Prepare chat request with proper model selection
      const chatRequest = {
        character: {
          ...session.character,
          model: 'Sweet Myth' // Use default model for voice calls, or get from session
        },
        messages: [{ role: 'user', content: userMessage }],
        userId: session.userId,
        conversationId: session.conversationId,
        nsfwMode: false
      };

      logger.info(`Generating AI response for session ${session.id} with model: Sweet Myth`);

      // Get AI response using existing chat service
      let fullResponse = '';
      for await (const chunk of processChat(chatRequest)) {
        if (chunk.type === 'chunk' && chunk.content) {
          fullResponse += chunk.content;
        } else if (chunk.type === 'final' && chunk.fullResponse) {
          fullResponse = chunk.fullResponse;
          break;
        }
      }

      if (fullResponse) {
        // Send AI response to client for chat history
        this.sendAIResponseToClient(session, fullResponse);
        
        // Transition to AI speaking with the response
        await this.transitionToAISpeaking(session, fullResponse);
      } else {
        // Fallback to idle if no response
        session.state = CallState.IDLE;
        this.sendStateUpdate(session, CallState.IDLE);
      }

    } catch (error: any) {
      logger.error('Error generating AI response:', error);
      this.sendErrorToClient(session, 'AI response generation failed');
      
      session.state = CallState.IDLE;
      this.sendStateUpdate(session, CallState.IDLE);
    }
  }

  private sendCommandToClient(session: CallSession, command: string): void {
    const message: CallMessage = {
      type: 'command',
      command
    };
    this.sendMessageToClient(session, message);
  }

  private sendStateUpdate(session: CallSession, state: CallState): void {
    const message: CallMessage = {
      type: 'state_change',
      state
    };
    this.sendMessageToClient(session, message);
  }

  private sendTranscriptUpdate(session: CallSession, text: string, isFinal: boolean): void {
    const message: CallMessage = {
      type: 'transcript_update',
      text,
      is_final: isFinal
    };
    this.sendMessageToClient(session, message);
  }

  private sendAIResponseToClient(session: CallSession, text: string): void {
    const message: CallMessage = {
      type: 'ai_response',
      text
    };
    this.sendMessageToClient(session, message);
  }

  private sendErrorToClient(session: CallSession, error: string): void {
    const message: CallMessage = {
      type: 'error',
      error
    };
    this.sendMessageToClient(session, message);
  }

  private sendMessageToClient(session: CallSession, message: CallMessage): void {
    if (session.clientWebSocket.readyState === WebSocket.OPEN) {
      session.clientWebSocket.send(JSON.stringify(message));
    }
  }
}

// Singleton instance
export const callService = new CallService();

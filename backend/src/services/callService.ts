/**
 * Real-Time Call Service
 * 
 * Core orchestrator for real-time voice conversations. Manages state transitions,
 * VAD processing, and coordinates with Groq (ASR) and Resemble.ai (TTS) services.
 */

import WebSocket from 'ws';
import axios from 'axios';
import FormData from 'form-data';
import { VoiceActivityDetector, createVAD } from '../utils/vad';
import { logger } from '../utils/logger';
import { processChat } from './chatService';
import { memoryOrchestrator } from './memoryOrchestrator';
import { supabaseAdmin } from '../config/database';
import { synthesizeResembleTTS } from './resembleTtsService';
import { getCharacterDefaultVoiceName } from '../config/characterVoices';

export enum CallState {
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
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
  audioBuffer: Buffer[]; // DEPRECATED: Now using completeAudioBlob (client-side assembly)
  transcriptBuffer: string;
  isActive: boolean;
  startTime: number;
  isTTSStreamingComplete?: boolean;
  nsfwMode?: boolean;
  /**
   * Timer used to detect end of speech based on lack of incoming chunks
   */
  speechEndTimer?: any;
  /**
   * Lock to prevent concurrent TTS processing
   */
  ttsProcessing?: boolean;
  /**
   * Cooldown to prevent rapid state transitions
   */
  lastStateChange?: number;
  /**
   * AbortController to cancel ongoing TTS requests
   */
  ttsAbortController?: AbortController | null;
  /**
   * Generation counter to prevent parallel AI response races.
   * Each generateAIResponse call increments this and checks if it's still current.
   */
  aiGenerationId?: number;
  /**
   * Conversation history accumulated during this call.
   * Each turn is stored so the LLM can see previous exchanges and avoid repetition.
   */
  callHistory: Array<{ role: string; content: string }>;
  /**
   * CLIENT-SIDE ASSEMBLY: Complete audio file assembled by client
   */
  completeAudioBlob?: Buffer;
  /**
   * VAD calibration state
   */
  isCalibrating?: boolean;
  calibrationSamples?: Buffer[];
  calibrationStartTime?: number;
}

export interface CallMessage {
  type: 'command' | 'transcript_update' | 'state_change' | 'error' | 'ai_response' | 'ai_response_chunk' | 'tts_finished' | 'tts_stream_end';
  command?: string;
  text?: string;
  is_final?: boolean;
  state?: CallState;
  error?: string;
}

export class CallService {
  private sessions: Map<string, CallSession> = new Map();
  private readonly GROQ_API_KEY = process.env.GROQ_API_KEY;
  private readonly GROQ_HTTP_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

  constructor() {
    if (!this.GROQ_API_KEY) {
      logger.error('GROQ_API_KEY environment variable is required');
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
    clientWebSocket: WebSocket,
    nsfwMode?: boolean
  ): CallSession {
    const session: CallSession = {
      id: sessionId,
      userId,
      characterId,
      character,
      state: CallState.LISTENING,
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
      startTime: Date.now(),
      nsfwMode: nsfwMode || false,
      callHistory: []
    };

    this.sessions.set(sessionId, session);

    // Set up client WebSocket event handlers
    this.setupClientWebSocket(session);

    logger.info(`Call session created: ${sessionId} for user ${userId}`);

    // Skip server-side VAD calibration — client VAD handles speech detection locally.
    // Go straight to LISTENING for instant readiness (no 500ms+ startup delay).
    // If the client still sends calibration_complete, it will be handled gracefully.
    session.isCalibrating = false;
    this.sendStateUpdate(session, CallState.LISTENING);
    logger.info(`🎤 Session ${sessionId} immediately ready for voice input (no calibration delay)`);

    return session;
  }

  /**
   * Process incoming audio data from client
   * NOTE: This is now only used for RAW AUDIO MODE testing
   * Normal mode uses CLIENT-SIDE ASSEMBLY (complete blob sent on speech end)
   */
  public async processAudioData(sessionId: string, audioData: Buffer): Promise<void> {
    logger.info(`🔧 RAW MODE: processAudioData called for session ${sessionId} with ${audioData.length} bytes`);
    
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.error(`Session not found: ${sessionId}`);
      return;
    }
    
    if (!session.isActive) {
      logger.warn(`Session not active: ${sessionId}`);
      return;
    }

    try {
      logger.info(`🔧 RAW MODE: Session ${sessionId} state: ${session.state}, buffer length: ${session.audioBuffer.length}`);
      
      // Only buffer audio in USER_SPEAKING state
      // State transition happens via user_speech_started message, not audio arrival
      if (session.state !== CallState.USER_SPEAKING) {
        logger.warn(`🔧 RAW MODE: Ignoring audio chunk in state: ${session.state} (expected USER_SPEAKING)`);
        return;
      }

      logger.info(`🔧 RAW MODE: Buffering audio chunk: ${audioData.length} bytes in USER_SPEAKING state`);

      // Buffer the chunk for transcription (raw mode only)
      session.audioBuffer.push(audioData);

    } catch (error: any) {
      logger.error('🔧 RAW MODE: Error processing audio data:', error);
      this.sendErrorToClient(session, 'Audio processing failed');
      // Return to listening on error
      session.state = CallState.LISTENING;
      this.sendStateUpdate(session, CallState.LISTENING);
      session.audioBuffer = [];
    }
  }

  private isPCMData(audioData: Buffer): boolean {
    // PCM data from ScriptProcessor is typically smaller chunks (4096 samples * 2 bytes = 8192 bytes)
    // Encoded audio (WebM) has file signatures and is usually larger
    const audioHex = audioData.subarray(0, 4).toString('hex');
    const isWebM = audioHex === '1a45dfa3';
    const isOgg = audioHex === '4f676753';
    
    // If it has an encoded signature, it's not PCM
    if (isWebM || isOgg) {
      return false;
    }
    
    // If it's a small chunk (typical ScriptProcessor output), likely PCM
    if (audioData.length <= 16384) { // 4096 samples * 2 bytes * 2 (some buffer)
      return true;
    }
    
    // Large chunks without encoding signatures are likely PCM too
    return true;
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
    try {
      // Attempt to stop any ongoing AI speech on the client
      this.sendCommandToClient(session, 'stop_playback');
    } catch {}
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
    logger.info(`🔌 Setting up WebSocket handlers for session ${session.id}`);
    
    session.clientWebSocket.on('close', () => {
      logger.info(`Client WebSocket closed for session ${session.id}`);
      this.endSession(session.id);
    });

    session.clientWebSocket.on('error', (error) => {
      logger.error(`Client WebSocket error for session ${session.id}:`, error);
      this.endSession(session.id);
    });

    session.clientWebSocket.on('message', (data: Buffer, isBinary: boolean) => {
      logger.info(`📨 WebSocket message received for session ${session.id}: isBinary=${isBinary}, length=${data.length}`);
      
      if (isBinary) {
        // Check if we're in calibration mode
        if (session.isCalibrating) {
          // Collect calibration audio samples
          if (!session.calibrationSamples) {
            session.calibrationSamples = [];
          }
          session.calibrationSamples.push(data);
          logger.debug(`📊 Collected calibration sample ${session.calibrationSamples.length} for session ${session.id}: ${data.length} bytes`);
          return;
        }
        
        // CLIENT-SIDE ASSEMBLY: Receive complete audio file from client
        logger.info(`🎵 Received complete audio blob from session ${session.id}: ${data.length} bytes`);
        
        // Store the complete audio file (replaces chunk buffering)
        // Accept in USER_SPEAKING or AI_PROCESSING to handle race condition where
        // state changes before binary audio arrives via WebSocket
        if (session.state === CallState.USER_SPEAKING || session.state === CallState.AI_PROCESSING) {
          session.completeAudioBlob = data;
          logger.info(`✅ Stored complete audio blob for session ${session.id} (state: ${session.state})`);
        } else {
          logger.warn(`Received audio blob in unexpected state: ${session.state}`);
        }
      } else {
        // Handle JSON messages
        try {
          const message = JSON.parse(data.toString());
          logger.info(`📝 Received JSON message from session ${session.id}:`, message);
          this.handleWebSocketMessage(session, message);
        } catch (error) {
          logger.error(`Failed to parse JSON message from session ${session.id}:`, error);
        }
      }
    });
  }

  private async handleWebSocketMessage(session: CallSession, message: any): Promise<void> {
    const timestamp = Date.now();
    logger.info(`[${timestamp}] Received WebSocket message for session ${session.id}:`, message);
    
    switch (message.type) {
      case 'user_speech_started':
        // VAD-GATED: Explicit signal that user has started speaking
        logger.info(`🎤 [${timestamp}] USER_SPEECH_STARTED message received for session ${session.id}`);
        
        // Allow interruption from any state (LISTENING, AI_PROCESSING, AI_SPEAKING)
        if (session.state === CallState.AI_PROCESSING || session.state === CallState.AI_SPEAKING) {
          logger.info(`🛑 User interrupted during ${session.state} - aborting current operation`);
          
          // Abort any ongoing TTS
          if (session.ttsAbortController) {
            session.ttsAbortController.abort();
            logger.info(`🛑 Aborted TTS for session ${session.id}`);
          }
          
          // TODO: Abort STT/LLM if needed (currently they're fire-and-forget)
        }
        
        // Transition to USER_SPEAKING from any state
        session.state = CallState.USER_SPEAKING;
        this.sendStateUpdate(session, CallState.USER_SPEAKING);
        logger.info(`✅ Session ${session.id} transitioned to USER_SPEAKING (VAD-triggered from ${session.state})`);
        
        // Clear audio buffer for new speech
        session.audioBuffer = [];
        
        // No timer - we wait for explicit user_speech_ended message from client VAD
        logger.info(`⏳ Waiting for user_speech_ended message from client VAD`);
        break;
      case 'user_speech_ended':
        // CLIENT-SIDE ASSEMBLY: User has stopped speaking and sent complete audio
        logger.info(`🔇 [${timestamp}] USER_SPEECH_ENDED message received for session ${session.id}`);
        if (session.state === CallState.USER_SPEAKING) {
          // Verify we received the complete audio blob
          if (!session.completeAudioBlob) {
            logger.error(`No audio blob found for session ${session.id} - cannot process`);
            session.state = CallState.LISTENING;
            this.sendStateUpdate(session, CallState.LISTENING);
            break;
          }
          
          logger.info(`✅ Session ${session.id} speech ended - processing ${session.completeAudioBlob.length} bytes with Groq`);
          session.state = CallState.AI_PROCESSING;
          this.sendStateUpdate(session, CallState.AI_PROCESSING);
          
          // Process the complete audio file with Groq
          try {
            await this.processAudioWithGroq(session);
          } catch (err) {
            logger.error('Error processing audio after speech end:', err);
            session.state = CallState.LISTENING;
            this.sendStateUpdate(session, CallState.LISTENING);
          } finally {
            // Clear the audio blob after processing
            delete session.completeAudioBlob;
          }
        } else {
          logger.warn(`Ignoring user_speech_ended in state: ${session.state}`);
        }
        break;
      case 'interrupt':
        const interruptStart = Date.now();
        logger.info(`⚡ [${interruptStart}] INTERRUPT command received for session ${session.id} - processing immediately`);
        this.handleInterruption(session);
        const interruptEnd = Date.now();
        logger.info(`⏱️ Interrupt processing took ${interruptEnd - interruptStart}ms`);
        break;
      case 'force_end_speech':
        logger.info(`Force ending speech for session ${session.id}`);
        if (session.state === CallState.USER_SPEAKING) {
          this.transitionToAIProcessing(session);
        }
        break;
      case 'tts_playback_finished':
        logger.info(`TTS playback finished for session ${session.id}`);
        this.handleTTSPlaybackFinished(session.id);
        break;
      case 'calibration_complete':
        logger.info(`Calibration complete message received for session ${session.id}`);
        this.completeVADCalibration(session);
        break;
      default:
        logger.warn(`Unknown message type: ${message.type}`);
    }
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

    // Note: We don't buffer PCM audio chunks here anymore
    // The encoded audio for transcription comes separately via the other path

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

  private parseTextForTTS(text: string): string {
    // Remove asterisks but keep the action text (user wants descriptions spoken)
    let parsed = text.replace(/\*/g, '');
    
    // Remove emojis and special characters that shouldn't be spoken
    parsed = parsed.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '');
    
    // Clean up extra whitespace
    parsed = parsed.replace(/\s+/g, ' ').trim();
    
    // If nothing left after parsing, use a fallback
    if (!parsed) {
      parsed = "Mmm-hmm."; // A natural vocal response
    }
    
    return parsed;
  }

  private splitTextForTTS(text: string): string[] {
    // Split text into reasonable chunks for TTS processing
    // Look for sentence boundaries first, then fall back to length-based splitting
    const sentences = text.split(/(?<=[.!?])\s+/);
    const chunks: string[] = [];
    let currentChunk = '';
    
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      
      // If adding this sentence would make the chunk too long, start a new chunk
      // Keep chunks under 800 chars — Resemble silently truncates long text
      if (currentChunk.length + trimmed.length > 800 && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = trimmed;
      } else {
        currentChunk += (currentChunk ? ' ' : '') + trimmed;
      }
    }
    
    // Add the last chunk if it has content
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    // If no chunks were created, split by length
    if (chunks.length === 0) {
      const words = text.split(' ');
      for (let i = 0; i < words.length; i += 200) {
        chunks.push(words.slice(i, i + 200).join(' '));
      }
    }
    
    return chunks.filter(chunk => chunk.trim().length > 0);
  }


  private async handleInterruption(session: CallSession): Promise<void> {
    const interruptStart = Date.now();
    logger.info(`🛑 [${interruptStart}] Session ${session.id}: Handling interruption in state ${session.state}`);

    // Handle interruption in AI_SPEAKING, AI_PROCESSING, or LISTENING states
    if (session.state === CallState.AI_SPEAKING) {
      logger.info(`🛑 Interrupting AI speech for session ${session.id}`);
      
      // Stop any ongoing TTS processing
      session.ttsProcessing = false;
      
      // Cancel any ongoing TTS request (most important for fast interruption)
      if (session.ttsAbortController) {
        const abortStart = Date.now();
        logger.info(`🛑 Aborting TTS request for session ${session.id}`);
        session.ttsAbortController.abort();
        session.ttsAbortController = null;
        logger.info(`⏱️ TTS abort took ${Date.now() - abortStart}ms`);
      }
      
      // Send stop playback command to client
      this.sendCommandToClient(session, 'stop_playback');
      
      // Clear audio buffer and start fresh
      session.audioBuffer = [];
      
      // DO NOT transition state here - let user_speech_started message handle it
      // This prevents: AI_SPEAKING → LISTENING → USER_SPEAKING race condition
      // Now it's just: AI_SPEAKING → USER_SPEAKING (cleaner, faster)
      
      const interruptEnd = Date.now();
      logger.info(`🛑 Session ${session.id} interrupted (TTS aborted, staying in ${session.state} until user_speech_started) in ${interruptEnd - interruptStart}ms`);
    } else if (session.state === CallState.AI_PROCESSING) {
      logger.info(`🛑 Interrupting AI processing for session ${session.id} - aborting TTS`);
      
      // Abort any ongoing TTS (LLM might still be generating, but we stop TTS)
      if (session.ttsAbortController) {
        session.ttsAbortController.abort();
        session.ttsAbortController = null;
      }
      
      // Clear audio buffer
      session.audioBuffer = [];
      
      // DO NOT transition state - let user_speech_started handle it
      logger.info(`🛑 Session ${session.id} processing interrupted (staying in ${session.state} until user_speech_started)`);
    } else if (session.state === CallState.LISTENING) {
      logger.info(`🛑 User wants to speak immediately in LISTENING state for session ${session.id}`);
      // Clear any existing audio buffer to start fresh
      session.audioBuffer = [];
      // Session is already in LISTENING, no state change needed
    } else {
      logger.debug(`Ignoring interruption in state ${session.state}`);
    }
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

      // CLIENT-SIDE ASSEMBLY: Use the complete audio blob sent by client
      // FALLBACK: For raw audio mode, concatenate chunks (testing only)
      let audioData: Buffer;
      
      if (session.completeAudioBlob) {
        // NORMAL MODE: Use client-assembled blob
        audioData = session.completeAudioBlob;
        logger.info(`🎵 Using client-assembled audio blob: ${audioData.length} bytes (valid WebM file)`);
      } else if (session.audioBuffer.length > 0) {
        // RAW AUDIO MODE FALLBACK: Concatenate chunks (may be corrupted)
        audioData = Buffer.concat(session.audioBuffer);
        logger.info(`🔧 RAW MODE: Concatenated ${session.audioBuffer.length} chunks into ${audioData.length} bytes (may be corrupted)`);
      } else {
        logger.warn(`⚠️ No audio data for session ${session.id} - returning to listening`);
        session.state = CallState.LISTENING;
        this.sendStateUpdate(session, CallState.LISTENING);
        return;
      }

      if (!audioData || audioData.length === 0) {
        logger.warn(`⚠️ Empty audio data for session ${session.id} - returning to listening`);
        session.state = CallState.LISTENING;
        this.sendStateUpdate(session, CallState.LISTENING);
        return;
      }

      logger.info(`Processing complete audio file: ${audioData.length} bytes`);
      
      // Minimum ~150ms of audio: 16kHz × 0.15s × 2 bytes + 44 byte WAV header ≈ 4844 bytes.
      // A mic tap produces a burst then silence — the tap itself is <10ms so the whole
      // clip will be tiny. Raising the floor rejects tap+silence clips before Whisper.
      if (audioData.length < 5000) {
        logger.warn(`⚠️ Audio file too small for session ${session.id}: ${audioData.length} bytes (< 5000) - returning to listening`);
        session.state = CallState.LISTENING;
        this.sendStateUpdate(session, CallState.LISTENING);
        return;
      }

      // ── Pre-STT noise gate: check audio energy before sending to Whisper ──
      // Whisper hallucinates entire phrases when fed silence/noise.
      // By measuring RMS energy of the PCM data we can skip the API call entirely.
      const rmsEnergy = this.calculateAudioRMS(audioData);
      logger.info(`🔊 Audio RMS energy for session ${session.id}: ${rmsEnergy.toFixed(4)} (threshold: 0.005)`);
      if (rmsEnergy < 0.005) {
        logger.info(`🔇 Audio below noise floor for session ${session.id} (RMS: ${rmsEnergy.toFixed(4)}) — skipping STT`);
        session.state = CallState.LISTENING;
        this.sendStateUpdate(session, CallState.LISTENING);
        session.audioBuffer = [];
        return;
      }

      // Detect audio format based on file signature
      const audioHex = audioData.subarray(0, 4).toString('hex');
      logger.info(`🔍 Audio header signature (first 4 bytes): ${audioHex}`);
      
      // Detect format from magic numbers
      const isWav = audioHex === '52494646'; // "RIFF" (WAV signature)
      const isWebM = audioHex === '1a45dfa3'; // WebM/EBML signature
      const isOgg = audioHex.startsWith('4f676753'); // Ogg signature "OggS"
      const isMP3 = audioHex.startsWith('494433') || audioHex === 'fffb' || audioHex === 'fff3'; // ID3 or MP3 sync
      
      let contentType: string;
      let filename: string;
      
      if (isWav) {
        contentType = 'audio/wav';
        filename = 'audio.wav';
        logger.info(`✅ Valid WAV audio detected (${audioData.length} bytes, 16kHz mono optimized for Groq)`);
      } else if (isWebM) {
        contentType = 'audio/webm';
        filename = 'audio.webm';
        logger.info(`✅ Valid WebM audio detected (${audioData.length} bytes)`);
      } else if (isOgg) {
        contentType = 'audio/ogg';
        filename = 'audio.ogg';
        logger.info(`✅ Valid Ogg audio detected (${audioData.length} bytes)`);
      } else if (isMP3) {
        contentType = 'audio/mpeg';
        filename = 'audio.mp3';
        logger.info(`✅ Valid MP3 audio detected (${audioData.length} bytes)`);
      } else {
        // Try WebM as default for backwards compatibility
        logger.warn(`⚠️ Unknown audio format (header: ${audioHex}), defaulting to audio/webm`);
        contentType = 'audio/webm';
        filename = 'audio.webm';
      }
      
      logger.info(`🎵 Sending to Groq: ${contentType} (${audioData.length} bytes, ~${(audioData.length / 16000).toFixed(2)}s estimated)`);

      // Create form data for Groq API with enhanced settings for better accuracy
      const form = new FormData();
      form.append('file', audioData, {
        filename: filename,
        contentType: contentType
      });
      form.append('model', 'whisper-large-v3'); // Use full model for better accuracy (not turbo)
      form.append('language', 'en');
      form.append('response_format', 'verbose_json'); // Get more detailed response
      form.append('temperature', '0'); // Lower temperature for more accurate transcription
      form.append('timestamp_granularities[]', 'word'); // Get word-level timestamps for better accuracy
      // Note: Removed boost parameter as it's not supported by Groq Whisper API
      // Note: Removed prompt as Whisper can hallucinate the prompt text when audio is short/empty

      // Send to Groq API
      logger.info(`🚀 Sending audio to Groq API for session ${session.id} (${audioData.length} bytes)`);
      let response;
      try {
        response = await axios.post(this.GROQ_HTTP_URL, form, {
          headers: {
            'Authorization': `Bearer ${this.GROQ_API_KEY}`,
            ...form.getHeaders()
          },
          timeout: 10000
        });
      } catch (error: any) {
        logger.error(`❌ Groq API error for session ${session.id}:`, error.response?.data || error.message);
        // Don't send error message to AI, just go back to listening
        session.state = CallState.LISTENING;
        this.sendStateUpdate(session, CallState.LISTENING);
        session.audioBuffer = [];
        return;
      }

      // Handle verbose_json response format
      const transcript = response.data.text || response.data.transcript || '';
      const confidence = response.data.confidence || 'unknown';
      const duration = response.data.duration || 0;
      const words = response.data.words || [];
      logger.info(`🎯 Groq transcription for session ${session.id}: "${transcript}" (confidence: ${confidence}, duration: ${duration}s, words: ${words.length})`);

      // ── Post-STT sanity check ──
      // Only reject transcripts that are literally impossible in a voice call.
      // Legitimate short words (yeah, okay, bye, hmm) are KEPT — the user might actually say them.
      const lowerTranscript = transcript.toLowerCase().trim();
      const impossiblePhrases = [
        'thanks for watching',
        'please subscribe',
        'please like and subscribe',
        'subtitles by',
        'transcribe everything accurately',
        'see you next time',
        'thanks for listening',
      ];
      const isImpossible = impossiblePhrases.some(phrase => 
        lowerTranscript === phrase || lowerTranscript === phrase + '.'
      );
      
      // Repetitive text — Whisper sometimes generates the same phrase looped
      const isRepetitive = /(.{8,})\1{2,}/.test(lowerTranscript);
      
      if (isImpossible || isRepetitive) {
        logger.warn(`🚫 Rejected impossible transcription for session ${session.id}: "${transcript}" (isImpossible: ${isImpossible}, isRepetitive: ${isRepetitive})`);
        session.audioBuffer = [];
        session.state = CallState.LISTENING;
        this.sendStateUpdate(session, CallState.LISTENING);
        return;
      }

      if (transcript && transcript.trim()) {
        // Send transcript to client immediately
        logger.info(`📝 Sending transcript to client: "${transcript}" (final: true)`);
        this.sendTranscriptUpdate(session, transcript, true);
        
        // Persist user message to chat history
        try {
          await supabaseAdmin.from('chat_history').insert({
            conversation_id: session.conversationId,
            user_id: session.userId,
            character_id: session.characterId,
            role: 'user',
            content: transcript
          });
          // Touch conversation updated_at
          await supabaseAdmin
            .from('conversations')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', session.conversationId);
        } catch (e: any) {
          logger.error('Failed to save user transcript to chat_history:', e?.message || e);
        }
        
        // Generate AI response with the actual transcript
        logger.info(`🤖 Generating AI response for session ${session.id} with transcript: "${transcript}"`);
        this.generateAIResponse(session, transcript);
      } else {
        logger.warn(`⚠️ Empty transcript for session ${session.id} - returning to listening`);
        // Don't send error message to AI, just go back to listening
        session.state = CallState.LISTENING;
        this.sendStateUpdate(session, CallState.LISTENING);
        session.audioBuffer = []; // Clear buffer for next attempt
      }

    } catch (error: any) {
      logger.error(`❌ Error processing audio with Groq for session ${session.id}:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        stack: error.stack
      });
      
      // Don't send error message to AI, just go back to listening
      logger.info(`⚠️ Returning to listening for session ${session.id} due to processing error`);
      session.state = CallState.LISTENING;
      this.sendStateUpdate(session, CallState.LISTENING);
      session.audioBuffer = [];
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

  /**
   * Calculate RMS (Root Mean Square) energy of audio data.
   * Works with WAV (reads PCM after 44-byte header) and raw buffers.
   * Returns a 0-1 float where 0 = silence, 1 = max volume.
   */
  private calculateAudioRMS(audioData: Buffer): number {
    try {
      let pcmStart = 0;
      const header = audioData.subarray(0, 4).toString('ascii');
      
      // For WAV files, skip the 44-byte header to get to PCM data
      if (header === 'RIFF' && audioData.length > 44) {
        pcmStart = 44;
      } else if (header.charCodeAt(0) === 0x1a) {
        // WebM/EBML — can't easily read PCM from container, return high energy
        // to avoid false rejection. The noise gate won't help for WebM but it
        // won't hurt either (we just skip it).
        return 1.0;
      }
      
      const pcmData = audioData.subarray(pcmStart);
      
      // Need at least 2 bytes for one 16-bit sample
      if (pcmData.length < 2) return 0;
      
      // Read 16-bit signed PCM samples (little-endian)
      const sampleCount = Math.floor(pcmData.length / 2);
      let sumSquares = 0;
      
      // Sample every 4th value for performance on large buffers
      const step = sampleCount > 10000 ? 4 : 1;
      let samplesRead = 0;
      
      for (let i = 0; i < sampleCount; i += step) {
        const sample = pcmData.readInt16LE(i * 2);
        const normalized = sample / 32768.0; // Normalize to -1..1
        sumSquares += normalized * normalized;
        samplesRead++;
      }
      
      return Math.sqrt(sumSquares / samplesRead);
    } catch (error) {
      logger.warn('Error calculating audio RMS, allowing through:', error);
      return 1.0; // On error, allow through to avoid false rejection
    }
  }

  private async openRimeConnection(session: CallSession, text: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        logger.info(`Starting Resemble TTS for session ${session.id} with text: "${text}"`);
        logger.info(`Text length: ${text.length} characters`);
        logger.info(`Text preview: "${text.substring(0, 200)}..."`);

        // Determine voice name from character
        // Use character's stored voice preference, or default based on character name
        const characterVoice = session.character.voice || getCharacterDefaultVoiceName(session.character.name || '');
        logger.info(`Using voice: ${characterVoice} for character: ${session.character.name}`);

        // Use existing AbortController from generateAIResponse
        // DO NOT create a new one here - it would replace the one used for interrupt checks
        if (!session.ttsAbortController) {
          logger.warn(`No AbortController found for session ${session.id}, creating one`);
          session.ttsAbortController = new AbortController();
        }

        // Synthesize speech using Resemble.ai (returns PCM stream - already parsed from WAV)
        const pcmStream = await synthesizeResembleTTS({
          text,
          voiceName: characterVoice,
          signal: session.ttsAbortController.signal
        });

        logger.info(`Resemble TTS started for session ${session.id}, streaming audio to client`);

        // Add timeout to prevent hanging
        const timeoutId = setTimeout(() => {
          logger.error(`Resemble TTS timeout for session ${session.id} - forcing completion`);
          pcmStream.destroy(); // Destroy the stream to stop any ongoing process
          resolve(); // Force resolve to prevent hanging
        }, 30000); // 30 second timeout (longer for Resemble)

        // Stream PCM data directly to client (already converted from WAV by synthesizeResembleTTS)
        pcmStream.on('data', (pcmChunk: Buffer) => {
          if (session.clientWebSocket.readyState === WebSocket.OPEN) {
            session.clientWebSocket.send(pcmChunk);
          }
        });

        pcmStream.on('end', () => {
          clearTimeout(timeoutId);
          logger.info(`Resemble TTS stream completed for session ${session.id}`);
          resolve(); // Resolve when stream is done
        });

        pcmStream.on('error', (error: any) => {
          clearTimeout(timeoutId);
          logger.error(`Resemble TTS stream error for session ${session.id}:`, error);
          reject(error);
        });
        
        // Handle abort signal
        session.ttsAbortController.signal.addEventListener('abort', () => {
          clearTimeout(timeoutId);
          logger.info(`Resemble TTS request aborted for session ${session.id}`);
          pcmStream.destroy(); // Destroy the stream to stop any ongoing process
          resolve(); // Resolve when aborted
        });

      } catch (error: any) {
        logger.error(`Error with Resemble TTS for session ${session.id}:`, {
          message: error.message,
          stack: error.stack
        });
        
        reject(error);
      }
    });
  }

  // Removed handleGroqMessage - Groq Whisper API doesn't support streaming

  private async generateAIResponse(session: CallSession, userMessage: string): Promise<void> {
    try {
      // If session already ended, do nothing
      if (!session.isActive) {
        logger.warn(`Skipping AI response - session ${session.id} is not active`);
        return;
      }
      // Prevent multiple AI responses from being generated simultaneously
      if (session.state !== CallState.AI_PROCESSING) {
        logger.warn(`Cannot generate AI response in state: ${session.state}`);
        return;
      }

          // Prepare chat request with optimized settings for voice calls
          const voiceOptimizedCharacter = {
            ...session.character,
            // Keep the user's selected model for voice calls
            model: session.character.model || session.character.preferredModel || 'Sweet Myth',
            // Add voice-specific instructions to the existing character prompt
            prompt: session.character.prompt + `

🎙️ VOICE CALL MODE:
- This is a real-time voice conversation.
- Keep responses concise but expressive.
- If user says something short, respond equally short.`
          };

          logger.info(`Voice call using model: ${voiceOptimizedCharacter.model} (from character.model: ${session.character.model})`);

      // Build messages from call history so the LLM can see previous turns
      // and avoid repeating actions/phrases. Cap at last 20 messages (~10 turns).
      // At ~150 tokens/msg average, 20 msgs = ~3k tokens, leaving room for system prompt.
      const historyMessages = session.callHistory.slice(-20);
      const allMessages = [...historyMessages, { role: 'user', content: userMessage }];

      // Add current user turn to call history immediately
      session.callHistory.push({ role: 'user', content: userMessage });

      const chatRequest = {
        character: voiceOptimizedCharacter,
        messages: allMessages,
        userId: session.userId,
        conversationId: session.conversationId,
        nsfwMode: session.nsfwMode || false,
        isVoiceCall: true // Triggers shorter response instructions in processChat
      };

      logger.info(`Voice call history: ${historyMessages.length} previous turns + current message`);

      logger.info(`Generating AI response for session ${session.id} with model: ${voiceOptimizedCharacter.model}, NSFW: ${chatRequest.nsfwMode}`);

      // CRITICAL: Abort any previous generation and create a fresh AbortController.
      // This prevents parallel AI responses from racing when VAD splits a phrase.
      if (session.ttsAbortController) {
        session.ttsAbortController.abort();
        logger.info(`🛑 Aborted previous AI generation for session ${session.id}`);
      }
      session.ttsAbortController = new AbortController();
      const generationId = (session.aiGenerationId || 0) + 1;
      session.aiGenerationId = generationId;
      logger.info(`✅ Created fresh AbortController for session ${session.id} AI response (generation #${generationId})`);

      // Stream TTS by sentence as AI response is generated
      let fullResponse = '';
      let sentenceBuffer = '';
      let chunkCount = 0;
      let ttsStarted = false;
      
      logger.info(`Generating AI response with sentence-by-sentence TTS for session ${session.id}`);
      
      let moderationBlocked = false;
      
      for await (const chunk of processChat(chatRequest)) {
        // Check if session was interrupted or ended
        if (!session.isActive || session.ttsAbortController?.signal.aborted) {
          logger.info(`🛑 [INTERRUPT] Stopping AI response generation for session ${session.id} (isActive: ${session.isActive}, aborted: ${session.ttsAbortController?.signal.aborted})`);
          break;
        }
        
        chunkCount++;
        logger.debug(`AI stream chunk ${chunkCount} for session ${session.id}: type=${chunk.type}, content length=${chunk.content?.length || 0}`);
        
        if (chunk.type === 'error') {
          // Content was blocked by moderation
          moderationBlocked = true;
          logger.error(`🚫 [MODERATION] Content blocked for session ${session.id}: ${chunk.error}`);
          
          // Send error message to client
          this.sendErrorToClient(session, chunk.error || 'Content blocked by moderation');
          
          // Reset state to listening
          session.state = CallState.LISTENING;
          this.sendStateUpdate(session, CallState.LISTENING);
          
          break;
        } else if (chunk.type === 'chunk' && chunk.content) {
          fullResponse += chunk.content;
          sentenceBuffer += chunk.content;
          
          // Stream chunks to client in real-time for UI display
          this.sendAIResponseChunkToClient(session, chunk.content);
          
          // No mid-stream sentence processing - just accumulate text for final TTS
        } else if (chunk.type === 'final' && chunk.fullResponse) {
          fullResponse = chunk.fullResponse;
          logger.info(`AI stream final chunk received for session ${session.id}, total chunks: ${chunkCount}`);
          break;
        }
      }
      
      // If content was blocked, don't process TTS or save to history
      if (moderationBlocked) {
        logger.info(`🚫 [MODERATION] Skipping TTS and history save for session ${session.id} due to blocked content`);
        return;
      }
      
      // Process the complete response for TTS (only after streaming is done)
      const completeText = sentenceBuffer.trim();
      logger.info(`📝 [FINAL TTS] Complete text: "${completeText}" (length: ${completeText.length})`);
      
      // Check if this generation is still current (a newer one may have started)
      if (session.aiGenerationId !== generationId) {
        logger.info(`🛑 [STALE] Generation #${generationId} superseded by #${session.aiGenerationId} — skipping TTS for session ${session.id}`);
        return;
      }

      if (completeText.length > 0 && session.isActive && !session.ttsAbortController?.signal.aborted) {
        // Start TTS session
        if (!ttsStarted) {
          session.state = CallState.AI_SPEAKING;
          this.sendStateUpdate(session, CallState.AI_SPEAKING);
          ttsStarted = true;
        }
        
        // Split text into reasonable chunks for TTS processing
        const chunks = this.splitTextForTTS(completeText);
        logger.info(`🎤 [TTS CHUNKS] Split into ${chunks.length} chunks for TTS processing`);
        
        // Process each chunk sequentially
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk && chunk.trim().length > 0) {
            // Check if interrupted before each chunk
            if (!session.isActive || session.ttsAbortController?.signal.aborted) {
              logger.info(`🛑 [INTERRUPT] Stopping TTS processing at chunk ${i + 1}`);
              break;
            }
            
            logger.info(`🎤 [TTS CHUNK ${i + 1}/${chunks.length}] Processing: "${chunk.substring(0, 100)}..."`);
            await this.processImmediateTTS(session, chunk);
            logger.info(`✓ [TTS CHUNK ${i + 1} DONE] Complete`);
          }
        }
        
        logger.info(`✅ [ALL TTS CHUNKS DONE] Full response TTS complete`);
        
        // Signal frontend that ALL TTS audio has been sent.
        // Frontend must wait for this before firing tts_playback_finished.
        this.sendMessageToClient(session, { type: 'tts_stream_end' } as CallMessage);
        logger.info(`📡 [TTS_STREAM_END] Sent to client for session ${session.id}`);
      } else if (session.ttsAbortController?.signal.aborted) {
        logger.info(`🛑 [INTERRUPT] Skipping final text TTS (session interrupted)`);
      } else if (completeText.length === 0) {
        logger.info(`📝 [FINAL CHECK] No text to process`);
      }
      
      logger.info(`📝 AI response streaming completed for session ${session.id}, total length: ${fullResponse.length} chars`);
      logger.info(`📝 Full response: "${fullResponse}"`);
      logger.info(`⚠️  NO MORE TTS CALLS AFTER THIS POINT - All TTS already processed during streaming`);

      if (fullResponse) {
        // Store assistant response in call history for context in future turns
        session.callHistory.push({ role: 'assistant', content: fullResponse });

        // Send final AI response to client for chat history (after all chunks)
        this.sendAIResponseToClient(session, fullResponse);
        
        // All database operations run in parallel to avoid blocking TTS
        const deductCreditsPromise = (async () => {
          try {
            // Check welcome credits first, then voice credits
            const { data: profile } = await supabaseAdmin
              .from('profiles')
              .select('welcome_credits, voice_credits')
              .eq('id', session.userId)
              .maybeSingle();
            
            if (profile) {
              const welcomeCredits = Number(profile.welcome_credits || 0);
              
              if (welcomeCredits > 0) {
                // Deduct from welcome credits first
                const { error: rpcError } = await supabaseAdmin.rpc('decrement_welcome_credits', {
                  user_id: session.userId,
                  amount: 1
                });
                
                if (rpcError) {
                  logger.warn('Failed to deduct welcome credit via RPC, falling back to manual update:', rpcError);
                  // Fallback to manual update
                  const current = welcomeCredits;
                  await supabaseAdmin
                    .from('profiles')
                    .update({ 
                      welcome_credits: Math.max(0, current - 1),
                      has_used_welcome_credits: current - 1 <= 0 ? true : undefined
                    })
                    .eq('id', session.userId);
                }
              } else {
                // Deduct from regular voice credits
                const { error: rpcError } = await supabaseAdmin.rpc('decrement_voice_credits', { 
                  user_id: session.userId, 
                  amount: 1 
                });
                
                if (rpcError) {
                  logger.warn('Failed to deduct voice credit via RPC, falling back to manual update:', rpcError);
                  // Fallback to manual update
                  const current = Number(profile.voice_credits || 0);
                  await supabaseAdmin
                    .from('profiles')
                    .update({ voice_credits: Math.max(0, current - 1) })
                    .eq('id', session.userId);
                }
              }
            }
          } catch (e: any) {
            logger.error('Failed to deduct credit:', e?.message || e);
          }
        })();
        
        Promise.all([
          // Persist assistant response
          supabaseAdmin.from('chat_history').insert({
            conversation_id: session.conversationId,
            user_id: session.userId,
            character_id: session.characterId,
            role: 'assistant',
            content: fullResponse
          }),
          // Update conversation timestamp
          supabaseAdmin
            .from('conversations')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', session.conversationId),
          // Deduct voice credit
          deductCreditsPromise,
        ]).catch((e: any) => {
          logger.error('Failed to save assistant response or update credits:', e?.message || e);
        });
        
        // Trigger memory extraction asynchronously (non-blocking)
        memoryOrchestrator.extractAndStoreMemories({
          userId: session.userId,
          characterId: session.characterId,
          conversation: `user: ${userMessage}\nassistant: ${fullResponse}`
        }).catch((e: any) => {
          logger.warn('Memory extraction (call) failed:', e?.message || e);
        });
        
        // TTS already processed sentence-by-sentence during streaming
        // Transition back to listening after all TTS complete
        logger.info(`✅ All TTS sentences processed for session ${session.id}`);
        
      } else {
        // Fallback to listening if no response, clear buffer
        session.audioBuffer = [];
        session.state = CallState.LISTENING;
        this.sendStateUpdate(session, CallState.LISTENING);
      }
      
      // Clean up AbortController after entire AI response is complete
      session.ttsAbortController = null;
      logger.info(`🧹 Cleaned up AbortController for session ${session.id}`);

    } catch (error: any) {
      logger.error('Error generating AI response:', error);
      this.sendErrorToClient(session, 'AI response generation failed');
      
      session.state = CallState.IDLE;
      this.sendStateUpdate(session, CallState.IDLE);
      
      // Clean up AbortController on error
      session.ttsAbortController = null;
    }
  }

  /**
   * Process TTS immediately for a single sentence (streaming approach)
   */
  private async processImmediateTTS(session: CallSession, sentence: string): Promise<void> {
    try {
      // Parse text for TTS - remove action markers
      const spokenText = this.parseTextForTTS(sentence);
      if (spokenText.trim().length === 0) {
        logger.warn(`Empty spoken text after parsing: "${sentence}"`);
        return;
      }
      
      logger.info(`🎙️ [TTS START] Session ${session.id}: "${spokenText.substring(0, 100)}..." (${spokenText.length} chars)`);
      
      // Process TTS for this sentence
      await this.openRimeConnection(session, spokenText);
      
      logger.info(`✅ [TTS COMPLETE] Session ${session.id}: "${spokenText.substring(0, 50)}..."`);
      
    } catch (error: any) {
      logger.error(`❌ [TTS ERROR] Session ${session.id} for sentence "${sentence.substring(0, 50)}...":`, error);
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
    // Removed cooldown for instant UI response
    logger.info(`🔄 [BACKEND STATE] Sending state change to session ${session.id}: ${state}`);
    
    // Check WebSocket state before sending
    if (session.clientWebSocket.readyState !== WebSocket.OPEN) {
      logger.warn(`🔄 [BACKEND STATE] WebSocket not open for session ${session.id}, state: ${session.clientWebSocket.readyState}`);
      return;
    }
    
    const message: CallMessage = {
      type: 'state_change',
      state
    };
    
    try {
      this.sendMessageToClient(session, message);
      logger.info(`🔄 [BACKEND STATE] State change message sent for session ${session.id}: ${state}`);
    } catch (error) {
      logger.error(`🔄 [BACKEND STATE] Failed to send state change for session ${session.id}:`, error);
    }
  }

  private sendTranscriptUpdate(session: CallSession, text: string, isFinal: boolean): void {
    const message: CallMessage = {
      type: 'transcript_update',
      text,
      is_final: isFinal
    };
    logger.info(`📝 Sending transcript update to session ${session.id}: "${text}" (final: ${isFinal})`);
    this.sendMessageToClient(session, message);
  }

  private sendAIResponseToClient(session: CallSession, text: string): void {
    const message: CallMessage = {
      type: 'ai_response',
      text
    };
    this.sendMessageToClient(session, message);
  }

  private sendAIResponseChunkToClient(session: CallSession, text: string): void {
    logger.debug(`Sending AI response chunk to session ${session.id}: "${text}"`);
    const message: CallMessage = {
      type: 'ai_response_chunk',
      text
    };
    this.sendMessageToClient(session, message);
    logger.debug(`AI response chunk sent successfully to session ${session.id}`);
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

  /**
   * Handle notification that TTS playback has finished on the client
   */
  async handleTTSPlaybackFinished(sessionId: string): Promise<void> {
    logger.info(`[TTS FINISHED] ===== HANDLING TTS PLAYBACK FINISHED =====`);
    logger.info(`[TTS FINISHED] Session ID: ${sessionId}`);
    
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.error(`[TTS FINISHED] ❌ Session ${sessionId} not found for TTS playback finished`);
      return;
    }

    logger.info(`[TTS FINISHED] Session found - Current state: ${session.state}`);
    logger.info(`[TTS FINISHED] isTTSStreamingComplete: ${session.isTTSStreamingComplete}`);

    // Always transition to LISTENING if we're in AI_SPEAKING state
    if (session.state === CallState.AI_SPEAKING) {
      logger.info(`[TTS FINISHED] ✅ Valid state transition: AI_SPEAKING → LISTENING`);
      session.state = CallState.LISTENING;
      session.isTTSStreamingComplete = false; // Reset for next TTS
      session.audioBuffer = []; // Clear audio buffer for next utterance
      
      logger.info(`[TTS FINISHED] Sending state update to client: LISTENING`);
      this.sendStateUpdate(session, CallState.LISTENING);
      logger.info(`[TTS FINISHED] ✅ Session ${sessionId} successfully transitioned to LISTENING - ready for user input`);
    } else {
      logger.error(`[TTS FINISHED] ❌ Invalid state for transition: current=${session.state}, expected=AI_SPEAKING`);
      // Force transition anyway for debugging
      logger.info(`[TTS FINISHED] 🔧 Force transitioning to LISTENING regardless of current state`);
      session.state = CallState.LISTENING;
      session.isTTSStreamingComplete = false;
      session.audioBuffer = [];
      this.sendStateUpdate(session, CallState.LISTENING);
      logger.info(`[TTS FINISHED] 🔧 Force transition complete - session ${sessionId} now in LISTENING state`);
    }
    
    logger.info(`[TTS FINISHED] ===== TTS PLAYBACK FINISHED COMPLETE =====`);
  }

  /**
   * Start VAD calibration phase
   * Requests background noise samples from client to adjust VAD threshold
   */
  private startVADCalibration(session: CallSession): void {
    logger.info(`🎯 Starting VAD calibration for session ${session.id}`);
    
    // Initialize calibration state
    session.isCalibrating = true;
    session.calibrationSamples = [];
    session.calibrationStartTime = Date.now();
    
    // Request calibration audio from client
    // Calibration duration: 500ms of background noise (enough for noise floor detection)
    const calibrationDuration = 500; // 500ms - faster startup, user can speak sooner
    
    session.clientWebSocket.send(JSON.stringify({
      type: 'calibration_start',
      duration: calibrationDuration,
      message: 'Please remain silent for background noise calibration...'
    }));
    
    logger.info(`📡 Sent calibration_start message to client for session ${session.id}`);
    
    // Set timeout to complete calibration if client doesn't respond
    setTimeout(() => {
      if (session.isCalibrating) {
        logger.warn(`⏰ Calibration timeout for session ${session.id}, completing with collected samples`);
        this.completeVADCalibration(session);
      }
    }, calibrationDuration + 1000); // Give extra 1 second buffer
  }

  /**
   * Complete VAD calibration and adjust threshold
   */
  private completeVADCalibration(session: CallSession): void {
    if (!session.isCalibrating) {
      logger.warn(`Calibration not active for session ${session.id}`);
      return;
    }

    logger.info(`✅ Completing VAD calibration for session ${session.id}`);
    
    const samples = session.calibrationSamples || [];
    const sampleCount = samples.length;
    
    if (sampleCount === 0) {
      logger.warn(`⚠️ No calibration samples collected for session ${session.id}, using default threshold`);
      session.isCalibrating = false;
      delete session.calibrationSamples;
      delete session.calibrationStartTime;
      
      // Inform client calibration is complete
      session.clientWebSocket.send(JSON.stringify({
        type: 'calibration_complete',
        threshold: session.vad.getThreshold(),
        message: 'Calibration complete (no samples collected, using default)'
      }));
      
      // Transition to LISTENING state
      this.sendStateUpdate(session, CallState.LISTENING);
      return;
    }

    logger.info(`📊 Processing ${sampleCount} calibration samples for session ${session.id}`);
    
    // Calibrate VAD threshold based on collected samples
    const calibratedThreshold = session.vad.calibrateThreshold(samples);
    
    const calibrationDuration = session.calibrationStartTime 
      ? Date.now() - session.calibrationStartTime 
      : 0;
    
    logger.info(`🎯 VAD calibration complete for session ${session.id}: threshold=${calibratedThreshold.toFixed(6)}, samples=${sampleCount}, duration=${calibrationDuration}ms`);
    
    // Clear calibration state
    session.isCalibrating = false;
    delete session.calibrationSamples;
    delete session.calibrationStartTime;
    
    // Inform client calibration is complete
    session.clientWebSocket.send(JSON.stringify({
      type: 'calibration_complete',
      threshold: calibratedThreshold,
      sampleCount: sampleCount,
      duration: calibrationDuration,
      message: 'VAD calibration complete. You can now speak.'
    }));
    
    // Transition to LISTENING state
    this.sendStateUpdate(session, CallState.LISTENING);
    logger.info(`🎤 Session ${session.id} ready for voice input with calibrated VAD threshold`);
  }
}

// Singleton instance
export const callService = new CallService();

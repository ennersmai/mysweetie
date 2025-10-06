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
import { memoryOrchestrator } from './memoryOrchestrator';
import { supabaseAdmin } from '../config/database';

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
  audioBuffer: Buffer[];
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
      nsfwMode: nsfwMode || false
    };

    this.sessions.set(sessionId, session);

    // Set up client WebSocket event handlers
    this.setupClientWebSocket(session);

    logger.info(`Call session created: ${sessionId} for user ${userId}`);

    // Immediately inform client we're in LISTENING state so UI can reflect correctly
    this.sendStateUpdate(session, CallState.LISTENING);
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
      // Only process audio when we're actively listening
      if (session.state !== CallState.LISTENING) {
        logger.debug(`Ignoring audio chunk in state: ${session.state}`);
        return;
      }

      // For production, the frontend sends encoded chunks (250ms). We'll detect speech by activity:
      // - On first chunk while LISTENING → enter USER_SPEAKING immediately
      // - Reset a short silence timer on every chunk
      // - When the timer fires (no chunks for a bit) → transition to AI_PROCESSING

      logger.info(`Received audio chunk: ${audioData.length} bytes`);

      // Buffer the chunk
      session.audioBuffer.push(audioData);
      
      // Only transition to USER_SPEAKING after accumulating sufficient audio (min 10 chunks ~1000ms with 100ms chunks)
      // This prevents immediate transition on connection noise/silence
      if (session.state === CallState.LISTENING) {
        if (session.audioBuffer.length >= 10) {
          session.state = CallState.USER_SPEAKING;
          this.sendStateUpdate(session, CallState.USER_SPEAKING);
          logger.info(`🎤 Session ${session.id} transitioned to USER_SPEAKING after ${session.audioBuffer.length} chunks (${(session.audioBuffer.length * 100)}ms)`);
        } else {
          logger.debug(`🎤 Session ${session.id} still in LISTENING, buffering (${session.audioBuffer.length}/10 chunks)`);
        }
      }

      // Reset end-of-speech timer (silence-based) - reduced to 200ms for faster response with smaller chunks
      if (session.speechEndTimer) {
        clearTimeout(session.speechEndTimer);
      }
      session.speechEndTimer = setTimeout(async () => {
        try {
          if (!session.isActive) return;
          if (session.state !== CallState.USER_SPEAKING) return;
          logger.info(`🔇 Session ${session.id} speech end timer fired - transitioning to AI_PROCESSING`);
          session.state = CallState.AI_PROCESSING;
          this.sendStateUpdate(session, CallState.AI_PROCESSING);
          await this.processAudioWithGroq(session);
        } catch (err) {
          logger.error('Error on speech end timer:', err);
        }
      }, 2000); // end-of-speech after 2000ms of no chunks (allows for natural pauses in longer sentences)

    } catch (error: any) {
      logger.error('Error processing audio data:', error);
      this.sendErrorToClient(session, 'Audio processing failed');
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
    session.clientWebSocket.on('close', () => {
      logger.info(`Client WebSocket closed for session ${session.id}`);
      this.endSession(session.id);
    });

    session.clientWebSocket.on('error', (error) => {
      logger.error(`Client WebSocket error for session ${session.id}:`, error);
      this.endSession(session.id);
    });

    session.clientWebSocket.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleWebSocketMessage(session, message);
      } catch (error) {
        // If it's not JSON, it's probably audio data
        this.processAudioData(session.id, data);
      }
    });
  }

  private handleWebSocketMessage(session: CallSession, message: any): void {
    logger.info(`Received WebSocket message for session ${session.id}:`, message);
    
    switch (message.type) {
      case 'interrupt':
        logger.info(`Handling interrupt for session ${session.id}`);
        this.handleInterruption(session);
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

  private async transitionToAISpeaking(session: CallSession, responseText: string): Promise<void> {
    logger.info(`Session ${session.id}: Transitioning to AI_SPEAKING immediately`);
    
    session.state = CallState.AI_SPEAKING;
    this.sendStateUpdate(session, CallState.AI_SPEAKING);

    // Parse text for TTS - remove action markers and extract spoken text
    const spokenText = this.parseTextForTTS(responseText);
    logger.info(`Original response text: "${responseText}" (${responseText.length} chars)`);
    logger.info(`Parsed text for TTS: "${spokenText}" (${spokenText.length} chars)`);

    // Send to TTS immediately - no sentence splitting for faster response
    await this.processImmediateTTS(session, spokenText);
  }

  private async processTTSBySentences(session: CallSession, text: string): Promise<void> {
    // Prevent concurrent TTS processing - wait if already processing
    if (session.ttsProcessing) {
      logger.warn(`TTS already processing for session ${session.id}, skipping duplicate request`);
      return;
    }
    
    session.ttsProcessing = true;
    
    try {
      // Parse text for TTS - remove action markers first
      const spokenText = this.parseTextForTTS(text);
      if (spokenText.trim().length === 0) {
        logger.warn(`Empty spoken text after parsing for session ${session.id}`);
        return;
      }
      
      logger.info(`Original text: "${text.substring(0, 100)}..." (${text.length} chars)`);
      logger.info(`Parsed for TTS: "${spokenText.substring(0, 100)}..." (${spokenText.length} chars)`);
      
      // Split text into sentences (better sentence detection)
      const sentences = this.splitIntoSentences(spokenText);
      logger.info(`Split TTS into ${sentences.length} sentences for session ${session.id}`);
      
      // Process each sentence through TTS sequentially
      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i]?.trim();
        if (sentence && sentence.length > 0) {
          logger.info(`Processing TTS sentence ${i + 1}/${sentences.length}: "${sentence.substring(0, 50)}..."`);
          await this.openRimeConnection(session, sentence);
          
          // Reduced delay between sentences for smoother playback (from 100ms to 50ms)
          if (i < sentences.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      }
      
      // Send final completion message after all sentences are processed
      logger.info(`All TTS sentences completed for session ${session.id} - sending tts_stream_end`);
      this.sendMessageToClient(session, {
        type: 'tts_stream_end'
      });
      session.isTTSStreamingComplete = true;
      
    } catch (error: any) {
      logger.error(`Error processing TTS by sentences for session ${session.id}:`, error);
      // Fallback to listening state, clear buffer for next speech
      session.audioBuffer = [];
      session.state = CallState.LISTENING;
      this.sendStateUpdate(session, CallState.LISTENING);
    } finally {
      // Always release the lock
      session.ttsProcessing = false;
    }
  }

  private splitIntoSentences(text: string): string[] {
    // More efficient sentence splitting that preserves original punctuation
    const sentenceEndings = /([.!?]+)/g;
    const parts = text.split(sentenceEndings);
    const sentences: string[] = [];
    
    for (let i = 0; i < parts.length; i += 2) {
      const sentence = parts[i]?.trim();
      const punctuation = parts[i + 1] || '';
      if (sentence) {
        sentences.push(sentence + punctuation);
      }
    }
    
    // If no sentences found, treat the whole text as one sentence
    return sentences.length > 0 ? sentences : [text];
  }

  private parseTextForTTS(text: string): string {
    // Remove asterisks but keep the action text
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

  private async handleInterruption(session: CallSession): Promise<void> {
    logger.info(`🛑 Session ${session.id}: Handling interruption`);

    // Stop any ongoing TTS processing
    session.ttsProcessing = false;
    
    // Clear any buffered audio since user interrupted
    session.audioBuffer = [];
    
    // Send stop playback command to client
    this.sendCommandToClient(session, 'stop_playback');

    // Reset VAD state
    session.vad.reset();
    
    // Transition back to listening immediately
    session.state = CallState.LISTENING;
    this.sendStateUpdate(session, CallState.LISTENING);
    
    logger.info(`🛑 Session ${session.id} interrupted and returned to LISTENING`);
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

      logger.info(`Audio buffer info for session ${session.id}: ${session.audioBuffer.length} chunks`);
      
      if (session.audioBuffer.length === 0) {
        logger.warn(`No audio data for session ${session.id}`);
        this.generateAIResponse(session, 'I didn\'t hear anything. Could you please repeat?');
        return;
      }

      // The frontend sends a single utterance per VAD segment, but network framing can split it.
      // Concatenate all buffered chunks to reconstruct the full file for this utterance.
      const audioData = Buffer.concat(session.audioBuffer);

      if (!audioData) {
        logger.warn(`No valid audio data found for session ${session.id}`);
        this.generateAIResponse(session, 'I didn\'t receive any audio. Could you try speaking again?');
        return;
      }

      logger.info(`Processing complete audio file: ${audioData.length} bytes`);
      
      if (audioData.length < 100) {
        logger.warn(`Audio file too small for session ${session.id}: ${audioData.length} bytes`);
        this.generateAIResponse(session, 'That was very brief. Could you speak a bit longer?');
        return;
      }

      // Detect audio format based on file signature
      const audioHex = audioData.subarray(0, 4).toString('hex');
      logger.info(`Audio header preview (first 4 bytes): ${audioHex}`);
      const isWebM = audioHex === '1a45dfa3'; // WebM signature
      const isOgg = audioHex === '4f676753'; // Ogg signature
      
      let contentType = 'audio/webm';
      let filename = 'audio.webm';
      
      if (isWebM) {
        contentType = 'audio/webm';
        filename = 'audio.webm';
      } else if (isOgg) {
        contentType = 'audio/ogg';
        filename = 'audio.ogg';
      }
      
      logger.info(`🎵 Processing audio: ${contentType} (${audioData.length} bytes, ${(audioData.length / 16000).toFixed(2)}s estimated)`);

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
      // Note: Removed prompt as Whisper can hallucinate the prompt text when audio is short/empty

      // Send to Groq API
      const response = await axios.post(this.GROQ_HTTP_URL, form, {
        headers: {
          'Authorization': `Bearer ${this.GROQ_API_KEY}`,
          ...form.getHeaders()
        },
        timeout: 10000
      });

      // Handle verbose_json response format
      const transcript = response.data.text || response.data.transcript || '';
      const confidence = response.data.confidence || 'unknown';
      const duration = response.data.duration || 0;
      const words = response.data.words || [];
      logger.info(`🎯 Groq transcription for session ${session.id}: "${transcript}" (confidence: ${confidence}, duration: ${duration}s, words: ${words.length})`);

      // Filter out common Whisper hallucinations (happens with silent/empty audio)
      const commonHallucinations = [
        'thank you',
        'thanks for watching',
        'you',
        'bye',
        'goodbye',
        'see you next time',
        'transcribe everything accurately',
        'please subscribe',
        'please like and subscribe'
      ];
      
      const lowerTranscript = transcript.toLowerCase().trim();
      const isHallucination = commonHallucinations.some(phrase => 
        lowerTranscript === phrase || lowerTranscript === phrase + '.'
      );
      
      // Also check if audio duration is suspiciously short (< 0.3 seconds likely silence)
      const isTooShort = duration > 0 && duration < 0.3;
      
      if (isHallucination || isTooShort) {
        logger.warn(`🚫 Rejected low-quality transcription for session ${session.id}: "${transcript}" (duration: ${duration}s, isHallucination: ${isHallucination}, isTooShort: ${isTooShort})`);
        // Go back to listening state without sending anything, clear buffer for next utterance
        session.audioBuffer = [];
        session.state = CallState.LISTENING;
        this.sendStateUpdate(session, CallState.LISTENING);
        return;
      }

      if (transcript && transcript.trim()) {
        // Send transcript to client
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
    return new Promise(async (resolve, reject) => {
    try {
      // Check if Rime API key is available
      if (!this.RIME_API_KEY) {
        logger.warn('RIME_API_KEY not configured, skipping TTS');
        resolve(); // Just resolve without doing TTS
        return;
      }

      logger.info(`Starting TTS for session ${session.id} with text: "${text}"`);

      // Use the same payload structure as the existing TTS controller
      // Match parameters from text messaging for consistent quality
      const payload = {
        speaker: session.character.voice || 'luna',
        text: text,
        modelId: 'arcana',
        repetition_penalty: 1.5, // Match text messaging
        temperature: 0.5, // Match text messaging
        top_p: 1, // Match text messaging
        samplingRate: 24000,
        max_tokens: 1200, // Match text messaging
        lang: 'eng'
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
        
        // Reject the promise on error
        reject(new Error(`Rime TTS failed with status ${response.status}: ${errText}`));
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
        logger.info(`Rime TTS sentence completed for session ${session.id}`);
        resolve(); // Resolve when this sentence is done
      });

      response.data.on('error', (error: any) => {
        logger.error(`Rime TTS stream error for session ${session.id}:`, error);
        reject(error);
      });

    } catch (error: any) {
      logger.error(`Error with Rime TTS for session ${session.id}:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
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

🎙️ VOICE CALL MODE - Additional Instructions:
- This is a real-time voice conversation
- Keep responses to 1-3 sentences (40-60 words maximum)
- Speak naturally without asterisk actions (*text*)
- Be conversational and engaging but more concise than text
- Maintain your personality while being brief
- Think "phone conversation" not "detailed description"`
          };

          logger.info(`Voice call using model: ${voiceOptimizedCharacter.model} (from character.model: ${session.character.model})`);

      const chatRequest = {
        character: voiceOptimizedCharacter,
        messages: [{ role: 'user', content: userMessage }],
        userId: session.userId,
        conversationId: session.conversationId,
        nsfwMode: session.nsfwMode || false // Use session's NSFW mode
      };

      logger.info(`Generating AI response for session ${session.id} with model: ${voiceOptimizedCharacter.model}, NSFW: ${chatRequest.nsfwMode}`);

      // Get AI response first, then send entire response to TTS at once
      let fullResponse = '';
      let chunkCount = 0;
      
      logger.info(`Generating complete AI response for session ${session.id}`);
      
      for await (const chunk of processChat(chatRequest)) {
        chunkCount++;
        logger.debug(`AI stream chunk ${chunkCount} for session ${session.id}: type=${chunk.type}, content length=${chunk.content?.length || 0}`);
        
        if (chunk.type === 'chunk' && chunk.content) {
          fullResponse += chunk.content;
          // Stream chunks to client in real-time for UI display
          this.sendAIResponseChunkToClient(session, chunk.content);
        } else if (chunk.type === 'final' && chunk.fullResponse) {
          fullResponse = chunk.fullResponse;
          logger.info(`AI stream final chunk received for session ${session.id}, total chunks: ${chunkCount}`);
          break;
        }
      }
      
      logger.info(`AI response completed for session ${session.id}, response length: ${fullResponse.length}`);
      logger.info(`AI response preview: "${fullResponse.substring(0, 200)}..."`);

      if (fullResponse) {
        // Send final AI response to client for chat history (after all chunks)
        this.sendAIResponseToClient(session, fullResponse);
        
        // All database operations run in parallel to avoid blocking TTS
        const deductCreditsPromise = (async () => {
          try {
            // Try RPC first
            const { error: rpcError } = await supabaseAdmin.rpc('decrement_voice_credits', { 
              user_id: session.userId, 
              amount: 1 
            });
            
            if (rpcError) {
              logger.warn('Failed to deduct voice credit via RPC, falling back to manual update:', rpcError);
              // Fallback to manual update
              const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('voice_credits')
                .eq('id', session.userId)
                .maybeSingle();
              
              if (profile) {
                const current = Number(profile.voice_credits || 0);
                await supabaseAdmin
                  .from('profiles')
                  .update({ voice_credits: Math.max(0, current - 1) })
                  .eq('id', session.userId);
              }
            }
          } catch (e: any) {
            logger.error('Failed to deduct voice credit:', e?.message || e);
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
        
        // Only start TTS if not already processing (prevent duplicates)
        if (!session.ttsProcessing) {
          // Transition to AI_SPEAKING and process TTS sentence by sentence for voice calls
          session.state = CallState.AI_SPEAKING;
          this.sendStateUpdate(session, CallState.AI_SPEAKING);
          logger.info(`Session ${session.id} transitioned to AI_SPEAKING - starting sentence-by-sentence TTS`);
          
          // Process TTS sentence by sentence to avoid cutoffs with long responses
          await this.processTTSBySentences(session, fullResponse);
        } else {
          logger.warn(`Skipping TTS for session ${session.id} - already processing another response`);
        }
        
      } else {
        // Fallback to listening if no response, clear buffer
        session.audioBuffer = [];
        session.state = CallState.LISTENING;
        this.sendStateUpdate(session, CallState.LISTENING);
      }

    } catch (error: any) {
      logger.error('Error generating AI response:', error);
      this.sendErrorToClient(session, 'AI response generation failed');
      
      session.state = CallState.IDLE;
      this.sendStateUpdate(session, CallState.IDLE);
    }
  }

  /**
   * Check if current text forms a complete sentence
   */
  private isCompleteSentence(text: string): boolean {
    const trimmed = text.trim();
    
    // Check for sentence-ending punctuation
    if (/[.!?]$/.test(trimmed)) {
      return true;
    }
    
    // Check for sufficient length (about 6-8 words for real-time streaming)
    const wordCount = trimmed.split(/\s+/).filter(word => word.length > 0).length;
    if (wordCount >= 6) {
      return true;
    }
    
    return false;
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
      
      logger.info(`🎙️ Starting immediate TTS for: "${spokenText}"`);
      
      // Process TTS for this sentence
      await this.openRimeConnection(session, spokenText);
      
    } catch (error: any) {
      logger.error(`Error in immediate TTS processing for sentence "${sentence}":`, error);
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
    logger.info(`🔄 [BACKEND STATE] Sending state change to session ${session.id}: ${state}`);
    const message: CallMessage = {
      type: 'state_change',
      state
    };
    this.sendMessageToClient(session, message);
    logger.info(`🔄 [BACKEND STATE] State change message sent for session ${session.id}`);
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
}

// Singleton instance
export const callService = new CallService();

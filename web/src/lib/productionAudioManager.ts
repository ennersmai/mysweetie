/**
 * Production-Ready Audio Manager for Voice Calls
 * 
 * Clean implementation focusing on reliability and simplicity
 */

export class ProductionAudioManager {
  private recordingContext: AudioContext | null = null; // For VAD analysis (native sample rate)
  private playbackContext: AudioContext | null = null; // For TTS playback (24kHz)
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioQueue: AudioBuffer[] = [];
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private onAudioData: ((data: ArrayBuffer) => void) | null = null;
  private onPlaybackComplete: (() => void) | null = null;
  private onSpeechStart: (() => void) | null = null;
  private onSpeechEnd: (() => void) | null = null;
  private onInterrupt: (() => void) | null = null; // Callback for interruption
  private micGainNode: GainNode | null = null;
  private recordingStream: MediaStream | null = null;
  private readonly micBoostFactor = 1.5; // Reduced from 4.0 to prevent distortion
  private isPlayingTTS = false; // Track if TTS is currently playing
  private rawAudioMode = false; // Debug flag to bypass VAD for AEC testing
  private isSendingAudio = false; // Track if we're actively recording speech (VAD-triggered)
  private manuallyStoppedPlayback = false; // Track if playback was manually stopped (to prevent onended from firing)
  private currentAudioChunks: Blob[] = []; // Buffer for assembling complete audio file client-side
  private recordedMimeType = 'audio/webm;codecs=opus'; // Store the actual mime type used by MediaRecorder
  private isInterruptRestart = false; // Flag to restart instantly on interrupt (minimize delay)

  // Simple VAD
  private analyserNode: AnalyserNode | null = null;
  private vadIntervalId: number | null = null;
  private vadSpeaking = false;
  private vadLastAboveThreshold = 0;
  private baseVadThreshold = 0.01; // Base threshold for normal operation
  private currentVadThreshold = 0.01; // Dynamic threshold that increases during TTS
  private readonly vadHangoverMs = 800; // Reduced for much faster response
  private vadConsecutiveFrames = 0; // Count consecutive frames above threshold
  private readonly vadMinFrames = 2; // Reduced from 3 for faster response
  private recentRmsValues: number[] = []; // Track recent RMS values for debugging

  async initialize(rawAudioMode: boolean = false): Promise<boolean> {
    try {
      // Initialize VAD state
      this.isPlayingTTS = false;
      this.rawAudioMode = rawAudioMode;
      
      if (rawAudioMode) {
        console.log('🔧 RAW AUDIO MODE ENABLED - Bypassing VAD for AEC verification');
      } else {
        console.log('ProductionAudioManager: Initializing audio system with VAD');
      }
      
      // Request microphone access with explicit echo cancellation
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true, // Enable noise suppression for cleaner audio
          autoGainControl: true,
          sampleRate: 48000
        }
      });

      // Verify and log what constraints were actually applied
      const track = this.mediaStream.getAudioTracks()[0];
      const settings = track.getSettings();
      const capabilities = track.getCapabilities ? track.getCapabilities() : {};
      
      console.log('🎤 Audio Track Capabilities:', {
        echoCancellation: capabilities.echoCancellation || 'N/A',
        noiseSuppression: capabilities.noiseSuppression || 'N/A',
        autoGainControl: capabilities.autoGainControl || 'N/A'
      });
      
      console.log('🎤 Audio Track Settings (Applied):', {
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount
      });
      
      if (!settings.echoCancellation) {
        console.warn('⚠️ WARNING: Echo cancellation is NOT enabled! This may cause feedback.');
      } else {
        console.log('✅ Echo cancellation is ENABLED');
      }

      // Create separate playback context at 24kHz for TTS (always needed)
      this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      console.log('ProductionAudioManager: Playback context created at', this.playbackContext.sampleRate, 'Hz');

      // RAW AUDIO MODE: Skip VAD setup entirely
      if (rawAudioMode) {
        console.log('🔧 RAW AUDIO MODE: Skipping VAD setup, using echo-cancelled stream directly');
        this.recordingStream = this.mediaStream; // Use original echo-cancelled stream
        return true;
      }

      // NORMAL MODE: Set up VAD with separate analysis pipeline
      // Create recording context at browser's native sample rate (usually 48kHz)
      this.recordingContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      console.log('ProductionAudioManager: Recording context created at', this.recordingContext.sampleRate, 'Hz');

      // Set up mic gain, analyser, and recording destination for VAD + boosted recording
      try {
        if (this.recordingContext) {
          const rawSource = this.recordingContext.createMediaStreamSource(this.mediaStream);
          this.micGainNode = this.recordingContext.createGain();
          this.micGainNode.gain.value = this.micBoostFactor;

          this.analyserNode = this.recordingContext.createAnalyser();
          this.analyserNode.fftSize = 1024;
          this.analyserNode.smoothingTimeConstant = 0.6;

          const destination = this.recordingContext.createMediaStreamDestination();

          rawSource.connect(this.micGainNode);
          this.micGainNode.connect(this.analyserNode);
          this.micGainNode.connect(destination);

          this.recordingStream = destination.stream;

          const timeDomain = new Float32Array(this.analyserNode.fftSize);
          const tick = () => {
            if (!this.analyserNode) return;
            this.analyserNode.getFloatTimeDomainData(timeDomain);
            let sum = 0;
            for (let i = 0; i < timeDomain.length; i++) {
              const v = timeDomain[i];
              sum += v * v;
            }
            const rms = Math.sqrt(sum / timeDomain.length);
            const now = performance.now();
            
            // Update recent RMS values for debugging
            this.recentRmsValues.push(rms);
            if (this.recentRmsValues.length > 50) {
              this.recentRmsValues.shift();
            }
            
            // Simple, fixed threshold during TTS - higher to prevent self-triggering
            if (this.isPlayingTTS) {
              // During TTS: 30x normal threshold to prevent echo from triggering VAD
              // You need to speak loudly to interrupt
              this.currentVadThreshold = this.baseVadThreshold * 30;
            } else {
              // Normal operation - use base threshold
              this.currentVadThreshold = this.baseVadThreshold;
            }
            
            // Log VAD activity occasionally for debugging
            if (Math.random() < 0.01) {
              const debugInfo = this.isPlayingTTS 
                ? `VAD: rms=${rms.toFixed(4)}, threshold=${this.currentVadThreshold.toFixed(4)} (30x), playing=TRUE, speaking=${this.vadSpeaking}`
                : `VAD: rms=${rms.toFixed(4)}, threshold=${this.currentVadThreshold.toFixed(4)} (1x), playing=false, speaking=${this.vadSpeaking}`;
              console.log(debugInfo);
            }
            
            if (rms >= this.currentVadThreshold) {
              this.vadLastAboveThreshold = now;
              this.vadConsecutiveFrames++;
              
              // Require more consecutive frames during TTS to prevent spurious triggers from audio glitches
              const requiredFrames = this.isPlayingTTS ? this.vadMinFrames * 2 : this.vadMinFrames;
              
              // Only confirm speech after consecutive frames
              if (!this.vadSpeaking && this.vadConsecutiveFrames >= requiredFrames) {
                this.vadSpeaking = true;
                const timestamp = performance.now();
                console.log(`🎤 VAD: SPEECH DETECTED at ${timestamp.toFixed(0)}ms (rms=${rms.toFixed(3)}, frames=${this.vadConsecutiveFrames}, threshold=${this.currentVadThreshold.toFixed(3)})`);
                
                // Check if this is an interrupt (speech during TTS session)
                // Use isPlayingTTS alone, not isPlaying (queue might be empty between sentences)
                const isInterrupt = this.isPlayingTTS;
                
                if (isInterrupt) {
                  console.log('🎤 Interrupt detected - stop/restart to exclude TTS, then capture from CURRENT moment');
                  // Stop current recording (contains TTS)
                  // The onstop handler will detect it's an interrupt and restart INSTANTLY
                  if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                    this.isInterruptRestart = true; // Flag for instant restart
                    this.currentAudioChunks = []; // Clear before stop fires
                    this.mediaRecorder.stop();
                  }
                } else {
                  console.log('🎤 Speech started - keeping MediaRecorder running to capture pre-roll');
                  this.currentAudioChunks = []; // Clear buffer for new utterance
                }
                
                this.isSendingAudio = true;
                
                // If user starts speaking during TTS, interrupt it IMMEDIATELY
                if (isInterrupt) {
                  const interruptStart = performance.now();
                  console.log(`🛑 VAD: User interrupted TTS at ${interruptStart.toFixed(0)}ms - stopping playback IMMEDIATELY`);
                  
                  // CRITICAL: Drop threshold IMMEDIATELY so we can continue tracking user's speech
                  this.currentVadThreshold = this.baseVadThreshold;
                  console.log(`🔧 VAD threshold dropped to normal (${this.currentVadThreshold.toFixed(4)}) to track user speech`);
                  
                  // Stop TTS playback
                  this.stopPlayback();
                  
                  // Send explicit interrupt command to backend
                  if (this.onInterrupt) {
                    console.log('⚡ Sending interrupt command to backend');
                    this.onInterrupt();
                  }
                  
                  const interruptEnd = performance.now();
                  console.log(`⏱️ Interrupt latency: ${(interruptEnd - interruptStart).toFixed(2)}ms`);
                }
                
                // ALWAYS notify backend that user started speaking (whether interrupting or not)
                // This ensures immediate transition to USER_SPEAKING state
                if (this.onSpeechStart) {
                  this.onSpeechStart();
                }
              }
            } else {
              // Reset consecutive frames counter
              this.vadConsecutiveFrames = 0;
              
              if (this.vadSpeaking && now - this.vadLastAboveThreshold > this.vadHangoverMs) {
                this.vadSpeaking = false;
                console.log(`🔇 VAD: SPEECH ENDED (silence for ${(now - this.vadLastAboveThreshold).toFixed(0)}ms)`);
                
                // CLIENT-SIDE ASSEMBLY: Stop MediaRecorder to finalize complete file
                this.isSendingAudio = false;
                
                if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                  console.log(`📦 Stopping MediaRecorder to finalize complete utterance (includes pre-roll)`);
                  this.mediaRecorder.stop();
                  // The onstop handler will trigger onSpeechEnd and restart for next utterance
                } else {
                  console.log(`⚠️ MediaRecorder not recording, cannot finalize`);
                }
              }
            }
          };
          this.vadIntervalId = window.setInterval(tick, 20); // Fast polling for responsive VAD
        }
      } catch (e) {
        console.warn('VAD setup failed, continuing without gating:', e);
      }

      return true;
    } catch (error) {
      console.error('Failed to initialize audio:', error);
      return false;
    }
  }

  startRecording(onAudioData: (data: ArrayBuffer) => void): boolean {
    // Use original echo-cancelled stream in raw mode, or processed stream in normal mode
    const streamToUse = this.rawAudioMode ? this.mediaStream : this.recordingStream;
    
    if (!streamToUse) {
      console.error('Media stream not initialized');
      return false;
    }

    this.onAudioData = onAudioData;

    // Explicitly request Groq-compatible audio format
    // Groq Whisper API works best with audio/webm;codecs=opus
    let mimeType = 'audio/webm;codecs=opus';
    
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      console.warn(`⚠️ ${mimeType} not supported, trying fallbacks...`);
      
      // Try fallback formats
      const fallbacks = [
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg'
      ];
      
      for (const format of fallbacks) {
        if (MediaRecorder.isTypeSupported(format)) {
          mimeType = format;
          console.log(`✅ Using fallback format: ${mimeType}`);
          break;
        }
      }
    }
    
    const options: MediaRecorderOptions = {
      mimeType: mimeType,
      audioBitsPerSecond: 128000 // Balanced for quality and size
    };
    
    // Store the mime type for use in getAssembledAudio()
    this.recordedMimeType = mimeType;
    
    console.log(`🎙️ MediaRecorder configured with mimeType: ${options.mimeType}, bitrate: ${options.audioBitsPerSecond}`);

    if (this.rawAudioMode) {
      console.log('🔧 RAW AUDIO MODE: Using original echo-cancelled MediaStream for MediaRecorder');
    }

    this.mediaRecorder = new MediaRecorder(streamToUse, options);
    
    // CLIENT-SIDE ASSEMBLY: Buffer complete audio file (with pre-roll)
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        // RAW AUDIO MODE: Send chunks unconditionally for testing
        if (this.rawAudioMode && this.onAudioData) {
          if (Math.random() < 0.05) {
            console.log(`🔧 RAW MODE: Sending ${event.data.size} bytes (bypassing VAD)`);
          }
          event.data.arrayBuffer().then((buf) => {
            this.onAudioData!(buf);
          });
        }
        // NORMAL MODE: Buffer complete audio file (only if not discarding)
        else if (!this.isInterruptRestart) {
          this.currentAudioChunks.push(event.data);
          console.log(`📦 Received complete audio file: ${event.data.size} bytes`);
        } else {
          console.log(`🗑️ Discarding contaminated chunk: ${event.data.size} bytes (contains TTS before interrupt)`);
        }
      }
    };
    
    // Handle MediaRecorder stop event (speech ended or interrupt restart)
    this.mediaRecorder.onstop = () => {
      console.log(`🛑 MediaRecorder stopped (interrupt: ${this.isInterruptRestart}, was recording speech: ${!this.isSendingAudio})`);
      
      // INTERRUPT RESTART: Restart INSTANTLY (no setTimeout)
      if (this.isInterruptRestart) {
        this.isInterruptRestart = false; // Reset flag
        if (this.mediaRecorder && this.mediaRecorder.state === 'inactive') {
          this.mediaRecorder.start(); // Immediate restart - no delay
          console.log('⚡ MediaRecorder restarted INSTANTLY after interrupt (zero setTimeout delay)');
        }
        return; // Don't process speech end
      }
      
      // NORMAL: Speech ended - trigger callback then restart for next utterance
      if (!this.isSendingAudio && this.currentAudioChunks.length > 0) {
        console.log(`🎤 Complete utterance captured (${this.currentAudioChunks.length} chunk), notifying callback`);
        if (this.onSpeechEnd) {
          this.onSpeechEnd();
        }
      }
      
      // Restart MediaRecorder for next utterance (small delay for normal case)
      setTimeout(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === 'inactive') {
          this.mediaRecorder.start();
          console.log('✅ MediaRecorder restarted - ready for next utterance');
        }
      }, 10);
    };

    // Start recording
    // RAW MODE: Use timeslice for continuous streaming
    // NORMAL MODE: No timeslice = complete file when stopped
    try {
      if (this.rawAudioMode) {
        this.mediaRecorder.start(50); // Timeslice for streaming chunks
        console.log('🔧 RAW MODE: MediaRecorder started with 50ms timeslice');
      } else {
        this.mediaRecorder.start(); // No timeslice = complete file when stopped
        console.log('📦 MediaRecorder started - will generate complete file on stop');
      }
    } catch (err) {
      console.error('Failed to start MediaRecorder:', err);
      return false;
    }

    console.log('Recording ready and active');
    return true;
  }

  stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      console.log('Recording stopped');
    }
  }

  /**
   * Play audio data (handles both PCM and encoded formats)
   */
  async playAudio(audioData: ArrayBuffer): Promise<void> {
    if (!this.playbackContext) {
      console.error('Playback context not initialized');
      return;
    }
    
    // Set TTS playing state ONLY if not already playing
    // This prevents resetting the flag when multiple sentences are streaming
    if (!this.isPlayingTTS) {
      console.log('🎵 Starting TTS playback session');
      this.isPlayingTTS = true;
      // Reset manual stop flag for new session
      this.manuallyStoppedPlayback = false;
    }

    try {
      // PCM audio from Rime.ai TTS - add to accumulator/queue
      if (this.isPCMData(audioData)) {
        if (Math.random() < 0.1) {
          console.log(`📦 Queuing PCM chunk ${audioData.byteLength} bytes`);
        }
        this.playPCMChunkImmediately(audioData);
      } else {
        console.log(`ProductionAudioManager: Decoding encoded audio ${audioData.byteLength} bytes`);
        // Try to decode as encoded audio
        const audioBuffer = await this.playbackContext.decodeAudioData(audioData.slice(0));
        console.log(`ProductionAudioManager: Decoded audio buffer ${audioBuffer.duration.toFixed(2)}s`);
        this.audioQueue.push(audioBuffer);
        
        // Start playback if not already playing
        if (!this.isPlaying) {
          this.playNextInQueue();
        }
      }
    } catch (error) {
      console.error('Error processing audio:', error);
    }
  }

  // PCM accumulation for smooth playback
  private pcmAccumulator: Int16Array[] = [];
  private pcmAccumulatorTimer: number | null = null;
  private readonly PCM_ACCUMULATION_TIME = 200; // ms - reduced for faster TTS response

  /**
   * Accumulate PCM chunks for smoother playback
   */
  private playPCMChunkImmediately(audioData: ArrayBuffer): void {
    if (!this.playbackContext) return;
    
    try {
      const samples = new Int16Array(audioData);
      
      // Add to accumulator
      this.pcmAccumulator.push(samples);
      
      // Reset timer
      if (this.pcmAccumulatorTimer) {
        clearTimeout(this.pcmAccumulatorTimer);
      }
      
      // Set timer to flush accumulator
      this.pcmAccumulatorTimer = window.setTimeout(() => {
        this.flushPCMAccumulator();
      }, this.PCM_ACCUMULATION_TIME);
      
      // If accumulator gets too large (>400ms worth), flush immediately
      const totalSamples = this.pcmAccumulator.reduce((sum, chunk) => sum + chunk.length, 0);
      const durationMs = (totalSamples / 24000) * 1000;
      
      if (durationMs > 400) { // More than 400ms accumulated - flush for faster response
        if (this.pcmAccumulatorTimer) {
          clearTimeout(this.pcmAccumulatorTimer);
          this.pcmAccumulatorTimer = null;
        }
        this.flushPCMAccumulator();
      }
      
    } catch (error) {
      console.error('Error accumulating PCM chunk:', error);
    }
  }

  /**
   * Flush accumulated PCM data into a single smooth audio buffer
   */
  private flushPCMAccumulator(): void {
    if (this.pcmAccumulator.length === 0 || !this.playbackContext) return;
    
    try {
      // Combine all accumulated chunks
      const totalLength = this.pcmAccumulator.reduce((sum, chunk) => sum + chunk.length, 0);
      const combinedSamples = new Int16Array(totalLength);
      
      let offset = 0;
      for (const chunk of this.pcmAccumulator) {
        combinedSamples.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Create single smooth audio buffer
      const audioBuffer = this.playbackContext.createBuffer(1, combinedSamples.length, 24000);
      const channelData = audioBuffer.getChannelData(0);
      
      for (let i = 0; i < combinedSamples.length; i++) {
        channelData[i] = combinedSamples[i] / 32768.0;
      }
      
      console.log(`📦 Flushed ${this.pcmAccumulator.length} PCM chunks → ${audioBuffer.duration.toFixed(3)}s buffer added to queue (queue length: ${this.audioQueue.length + 1})`);
      
      // Clear accumulator
      this.pcmAccumulator = [];
      this.pcmAccumulatorTimer = null;
      
      // Add to playback queue (will play sequentially)
      this.audioQueue.push(audioBuffer);
      
      // Start playback if not already playing
      if (!this.isPlaying) {
        console.log('🎵 Queue was idle, starting playback');
        this.playNextInQueue();
      } else {
        console.log(`⏳ Currently playing, buffer queued (${this.audioQueue.length} in queue)`);
      }
      
    } catch (error) {
      console.error('Error flushing PCM accumulator:', error);
      this.pcmAccumulator = [];
      this.pcmAccumulatorTimer = null;
    }
  }

  // Flush any remaining PCM data when TTS stream ends (called per sentence)
  flushRemainingPCM(): void {
    console.log('🔚 TTS sentence complete - flushing remaining PCM accumulator');
    if (this.pcmAccumulatorTimer) {
      clearTimeout(this.pcmAccumulatorTimer);
      this.pcmAccumulatorTimer = null;
    }
    this.flushPCMAccumulator();
  }


  private isPCMData(data: ArrayBuffer): boolean {
    // Simple heuristic: PCM data won't have file format signatures
    const view = new DataView(data);
    if (data.byteLength < 4) return true;
    
    const signature = view.getUint32(0, false);
    // Check for common audio file signatures
    const isWebM = signature === 0x1a45dfa3;
    const isOgg = signature === 0x4f676753;
    const isWav = signature === 0x52494646;
    
    return !isWebM && !isOgg && !isWav;
  }

  private playNextInQueue(): void {
    // Check if queue is empty
    if (this.audioQueue.length === 0) {
      console.log('✅ Audio queue empty - no more buffers to play');
      // NOTE: Do NOT set isPlaying = false here!
      // It will be set to false in the onended callback of the last buffer
      return;
    }

    // CRITICAL: Set isPlaying = true SYNCHRONOUSLY before any async operations
    this.isPlaying = true;
    // Reset manual stop flag (we're starting natural playback)
    this.manuallyStoppedPlayback = false;
    
    // Get next buffer from queue
    const audioBuffer = this.audioQueue.shift()!;
    
    console.log(`▶️  Playing buffer ${audioBuffer.duration.toFixed(3)}s (isPlaying: ${this.isPlaying}, ${this.audioQueue.length} remaining in queue)`);
    
    if (this.playbackContext) {
      this.currentSource = this.playbackContext.createBufferSource();
      this.currentSource.buffer = audioBuffer;
      
      // Add gain for better volume
      const gainNode = this.playbackContext.createGain();
      gainNode.gain.value = 1.5;
      
      this.currentSource.connect(gainNode);
      gainNode.connect(this.playbackContext.destination);
      
      this.currentSource.onended = () => {
        console.log(`✓ Buffer finished playing`);
        this.currentSource = null;
        
        // Check if playback was manually stopped (e.g., user interrupted)
        if (this.manuallyStoppedPlayback) {
          console.log('🛑 Ignoring onended (playback was manually stopped)');
          return;
        }
        
        // Check if there are more buffers in queue
        if (this.audioQueue.length > 0) {
          console.log(`⏭️  More buffers in queue (${this.audioQueue.length}), playing next`);
          // Recursively play next buffer (isPlaying stays true)
          this.playNextInQueue();
        } else {
          // Queue is empty - THIS is the only place isPlaying should be set to false
          console.log('🏁 Last buffer finished, queue empty - setting isPlaying = false');
          this.isPlaying = false;
          
          // Check if the TTS session was already marked as complete
          if (!this.isPlayingTTS && this.onPlaybackComplete) {
            // The backend already signaled that all TTS is done, and now the queue is empty
            console.log('✅ TTS session complete and queue empty - notifying backend');
            this.onPlaybackComplete();
          } else if (this.isPlayingTTS) {
            // More sentences may be coming
            console.log('⏸️  Queue empty but keeping isPlayingTTS=true (more sentences may be coming)');
          }
        }
      };
      
      this.currentSource.start();
    }
  }

  stopPlayback(): void {
    // Set flag to prevent onended callback from running
    this.manuallyStoppedPlayback = true;
    
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (error) {
        // Ignore errors when stopping already stopped sources
        console.log('Source already stopped or error stopping:', error);
      }
      this.currentSource = null;
    }
    
    // Clear audio queue and PCM buffer
    this.audioQueue = [];
    this.isPlaying = false;
    this.isPlayingTTS = false; // Reset TTS playing state
    
    // Clear PCM accumulator to prevent any remaining audio from playing
    if (this.pcmAccumulatorTimer) {
      clearTimeout(this.pcmAccumulatorTimer);
      this.pcmAccumulatorTimer = null;
    }
    this.pcmAccumulator = [];
    
    console.log('🛑 Playback stopped and cleared');
  }

  setPlaybackCompleteCallback(callback: (() => void) | null): void {
    console.log('ProductionAudioManager: Setting playback complete callback:', callback ? 'SET' : 'NULL');
    this.onPlaybackComplete = callback;
  }

  /**
   * Call this when the backend signals that ALL TTS for the AI response is complete
   * (not just one sentence, but the entire response)
   */
  public completeTTSSession(): void {
    console.log('🏁 TTS session complete signal received from backend');
    
    // Check if playback was manually stopped (user interrupted)
    if (this.manuallyStoppedPlayback) {
      console.log('🛑 Ignoring completion (playback was manually stopped by user interrupt)');
      // Reset the flag for next playback session
      this.manuallyStoppedPlayback = false;
      return;
    }
    
    // If we were in a TTS session, mark it as complete
    if (this.isPlayingTTS) {
      console.log('✅ Marking TTS session as complete');
      this.isPlayingTTS = false;
      
      // Only notify if the queue is actually empty (playback is done)
      if (!this.isPlaying && this.onPlaybackComplete) {
        console.log('🔔 Notifying backend: TTS playback complete');
        this.onPlaybackComplete();
      } else if (this.isPlaying) {
        console.log('⏳ Audio still playing, will notify when queue empties');
      }
    } else {
      console.log('ℹ️  No active TTS session to complete');
    }
  }

  setSpeechCallbacks(onSpeechStart: (() => void) | null, onSpeechEnd: (() => void) | null): void {
    this.onSpeechStart = onSpeechStart;
    this.onSpeechEnd = onSpeechEnd;
  }

  setInterruptCallback(callback: (() => void) | null): void {
    console.log('ProductionAudioManager: Setting interrupt callback:', callback ? 'SET' : 'NULL');
    this.onInterrupt = callback;
  }

  getAssembledAudio(): Blob | null {
    if (this.currentAudioChunks.length === 0) {
      console.warn('⚠️ No audio chunks to assemble');
      return null;
    }
    
    // Assemble all chunks into a single valid audio file
    // When MediaRecorder is stopped, it produces a complete, valid file
    const finalBlob = new Blob(this.currentAudioChunks, { type: this.recordedMimeType });
    
    // Read first few bytes for debugging
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer;
      const view = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
      const hex = Array.from(view).map(b => b.toString(16).padStart(2, '0')).join('');
      console.log(`🎵 Assembled ${this.currentAudioChunks.length} chunks → ${finalBlob.size} bytes, type: ${this.recordedMimeType}, header: ${hex}`);
    };
    reader.readAsArrayBuffer(finalBlob.slice(0, 4));
    
    // Clear the buffer
    this.currentAudioChunks = [];
    
    return finalBlob;
  }

  cleanup(): void {
    this.stopRecording();
    this.stopPlayback();
    
    if (this.vadIntervalId) {
      clearInterval(this.vadIntervalId);
      this.vadIntervalId = null;
    }
    this.analyserNode = null;
    this.vadSpeaking = false;
    this.vadLastAboveThreshold = 0;
    this.isSendingAudio = false;
    this.isInterruptRestart = false;

    // Clear PCM accumulator
    if (this.pcmAccumulatorTimer) {
      clearTimeout(this.pcmAccumulatorTimer);
      this.pcmAccumulatorTimer = null;
    }
    this.pcmAccumulator = [];
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    // Close both audio contexts
    if (this.recordingContext && this.recordingContext.state !== 'closed') {
      this.recordingContext.close();
      this.recordingContext = null;
    }

    if (this.playbackContext && this.playbackContext.state !== 'closed') {
      this.playbackContext.close();
      this.playbackContext = null;
    }

    this.mediaRecorder = null;
    this.onAudioData = null;
    this.onPlaybackComplete = null;
    
    console.log('Audio manager cleaned up');
  }
}

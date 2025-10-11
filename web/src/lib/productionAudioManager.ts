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
  private isInterrupted = false; // Track if TTS was interrupted by user speech
  private rawAudioMode = false; // Debug flag to bypass VAD for AEC testing
  private isSendingAudio = false; // Track if we're actively sending audio (VAD-gated)

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
  private recentRmsValues: number[] = []; // Track recent RMS values for adaptive threshold

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
            
            // Update recent RMS values for adaptive threshold
            this.recentRmsValues.push(rms);
            if (this.recentRmsValues.length > 50) {
              this.recentRmsValues.shift();
            }
            
            // Adaptive threshold: increase during TTS to prevent feedback
            if (this.isPlayingTTS) {
              // During TTS, use a higher threshold to prevent TTS from triggering VAD
              this.currentVadThreshold = this.baseVadThreshold * 3;
            } else {
              // Normal operation - use base threshold
              this.currentVadThreshold = this.baseVadThreshold;
            }
            
            // Log VAD activity occasionally for debugging
            if (Math.random() < 0.01) {
              console.log(`VAD: rms=${rms.toFixed(4)}, threshold=${this.currentVadThreshold.toFixed(4)}, playing=${this.isPlayingTTS}, speaking=${this.vadSpeaking}`);
            }
            
            if (rms >= this.currentVadThreshold) {
              this.vadLastAboveThreshold = now;
              this.vadConsecutiveFrames++;
              
              // Only confirm speech after consecutive frames
              if (!this.vadSpeaking && this.vadConsecutiveFrames >= this.vadMinFrames) {
                this.vadSpeaking = true;
                const timestamp = performance.now();
                console.log(`🎤 VAD: SPEECH DETECTED at ${timestamp.toFixed(0)}ms (rms=${rms.toFixed(3)}, frames=${this.vadConsecutiveFrames}, threshold=${this.currentVadThreshold.toFixed(3)})`);
                
                // VAD-GATED: Start sending audio to backend
                this.isSendingAudio = true;
                console.log('🚀 VAD-GATED: Now sending audio chunks to backend');
                
                // If user starts speaking during TTS, interrupt it
                if (this.isPlayingTTS && this.isPlaying) {
                  const interruptStart = performance.now();
                  console.log(`🛑 VAD: User interrupted TTS at ${interruptStart.toFixed(0)}ms - stopping playback`);
                  this.isInterrupted = true;
                  this.stopPlayback();
                  
                  // Send explicit interrupt command to backend (Task 2A)
                  if (this.onInterrupt) {
                    console.log('⚡ Sending interrupt command to backend');
                    this.onInterrupt();
                  }
                  
                  // Notify backend about interruption immediately
                  if (this.onPlaybackComplete) {
                    this.onPlaybackComplete();
                  }
                  
                  const interruptEnd = performance.now();
                  console.log(`⏱️ Interrupt latency: ${(interruptEnd - interruptStart).toFixed(2)}ms`);
                }
                
                // Notify UI for visual feedback (this will trigger user_speech_started message)
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
                
                // VAD-GATED: Stop sending audio to backend
                this.isSendingAudio = false;
                console.log('🛑 VAD-GATED: Stopped sending audio chunks to backend');
                
                // Notify UI
                if (this.onSpeechEnd) {
                  this.onSpeechEnd();
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

    // Determine best supported format - balanced bitrate for quality and size
    const options: MediaRecorderOptions = {
      audioBitsPerSecond: 128000 // Reduced from 256000 to prevent over-compression
    };
    
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      options.mimeType = 'audio/webm;codecs=opus';
    } else if (MediaRecorder.isTypeSupported('audio/webm')) {
      options.mimeType = 'audio/webm';
    }

    if (this.rawAudioMode) {
      console.log('🔧 RAW AUDIO MODE: Using original echo-cancelled MediaStream for MediaRecorder');
    }

    this.mediaRecorder = new MediaRecorder(streamToUse, options);
    
    // VAD-GATED AUDIO STREAMING: Only send audio when VAD detects speech
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0 && this.onAudioData) {
        // Only send audio if VAD has detected speech (isSendingAudio = true)
        if (this.isSendingAudio) {
          if (Math.random() < 0.05) {
            console.log(`✅ MediaRecorder sending: ${event.data.size} bytes (VAD active)`);
          }
          event.data.arrayBuffer().then((buf) => {
            this.onAudioData!(buf);
          });
        } else {
          // Silently drop audio when VAD hasn't detected speech
          if (Math.random() < 0.01) {
            console.log(`🚫 MediaRecorder dropping: ${event.data.size} bytes (VAD inactive, no speech detected)`);
          }
        }
      }
    };

    // Start recording with smaller chunks for better STT accuracy
    try {
      this.mediaRecorder.start(50); // Reduced to 50ms for faster transmission
      console.log('MediaRecorder started with 50ms timeslice - continuous audio streaming enabled');
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
    
    // Reset interruption flag and set TTS playing state
    this.isInterrupted = false;
    this.isPlayingTTS = true;

    try {
      // PCM audio from Rime.ai TTS - play immediately, no buffering
      if (this.isPCMData(audioData)) {
        console.log(`ProductionAudioManager: Playing PCM chunk immediately ${audioData.byteLength} bytes`);
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
      
      console.log(`ProductionAudioManager: Flushed ${this.pcmAccumulator.length} PCM chunks → ${audioBuffer.duration.toFixed(3)}s smooth buffer`);
      
      // Clear accumulator
      this.pcmAccumulator = [];
      this.pcmAccumulatorTimer = null;
      
      // Add to playback queue
      this.audioQueue.push(audioBuffer);
      
      // Start playback if not already playing
      if (!this.isPlaying) {
        this.playNextInQueue();
      }
      
    } catch (error) {
      console.error('Error flushing PCM accumulator:', error);
      this.pcmAccumulator = [];
      this.pcmAccumulatorTimer = null;
    }
  }

  // Flush any remaining PCM data when TTS stream ends
  flushRemainingPCM(): void {
    console.log('ProductionAudioManager: flushRemainingPCM called - flushing accumulator');
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
    if (this.audioQueue.length === 0) {
      console.log('ProductionAudioManager: Audio queue empty - playback complete');
      this.isPlaying = false;
      this.isPlayingTTS = false; // No longer playing TTS
      console.log(`ProductionAudioManager: About to check callback - hasCallback: ${!!this.onPlaybackComplete}, isPlaying: ${this.isPlaying}`);
      
      // Notify playback complete after a short delay to ensure audio has finished
      setTimeout(() => {
        console.log(`ProductionAudioManager: Timeout callback executing - hasCallback: ${!!this.onPlaybackComplete}, isPlaying: ${this.isPlaying}, interrupted: ${this.isInterrupted}`);
        
        if (!this.isInterrupted) {
          console.log('ProductionAudioManager: TTS completed normally');
        } else {
          console.log('ProductionAudioManager: TTS was interrupted by user speech');
        }
        
        if (this.onPlaybackComplete && !this.isPlaying) {
          console.log('ProductionAudioManager: 🔔 CALLING PLAYBACK COMPLETE CALLBACK');
          this.onPlaybackComplete();
          console.log('ProductionAudioManager: ✅ Playback complete callback executed successfully');
        } else {
          console.warn('ProductionAudioManager: ❌ Playback complete but conditions not met:', {
            hasCallback: !!this.onPlaybackComplete,
            isPlaying: this.isPlaying
          });
        }
      }, 100); // Reduced from 200ms for faster response
      return;
    }

    this.isPlaying = true;
    const audioBuffer = this.audioQueue.shift()!;
    
    console.log(`ProductionAudioManager: Playing audio buffer ${audioBuffer.duration.toFixed(3)}s (${this.audioQueue.length} remaining)`);
    
    if (this.playbackContext) {
      this.currentSource = this.playbackContext.createBufferSource();
      this.currentSource.buffer = audioBuffer;
      
      // Add gain for better volume
      const gainNode = this.playbackContext.createGain();
      gainNode.gain.value = 1.5;
      
      this.currentSource.connect(gainNode);
      gainNode.connect(this.playbackContext.destination);
      
      this.currentSource.onended = () => {
        console.log(`ProductionAudioManager: Audio buffer finished playing`);
        this.currentSource = null;
        this.playNextInQueue();
      };
      
      this.currentSource.start();
    }
  }

  stopPlayback(): void {
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

  setSpeechCallbacks(onSpeechStart: (() => void) | null, onSpeechEnd: (() => void) | null): void {
    this.onSpeechStart = onSpeechStart;
    this.onSpeechEnd = onSpeechEnd;
  }

  setInterruptCallback(callback: (() => void) | null): void {
    console.log('ProductionAudioManager: Setting interrupt callback:', callback ? 'SET' : 'NULL');
    this.onInterrupt = callback;
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

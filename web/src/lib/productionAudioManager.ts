/**
 * Production-Ready Audio Manager for Voice Calls
 * 
 * Clean implementation focusing on reliability and simplicity
 */

export class ProductionAudioManager {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioQueue: AudioBuffer[] = [];
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private onAudioData: ((data: ArrayBuffer) => void) | null = null;
  private onPlaybackComplete: (() => void) | null = null;
  private onSpeechStart: (() => void) | null = null;
  private onSpeechEnd: (() => void) | null = null;
  private micGainNode: GainNode | null = null;
  private recordingStream: MediaStream | null = null;
  private readonly micBoostFactor = 1.5; // Reduced from 4.0 to prevent distortion
  private isPlayingTTS = false; // Track if TTS is currently playing
  private isInterrupted = false; // Track if TTS was interrupted by user speech

  // Simple VAD
  private analyserNode: AnalyserNode | null = null;
  private vadIntervalId: number | null = null;
  private vadSpeaking = false;
  private vadLastAboveThreshold = 0;
  private baseVadThreshold = 0.01; // Base threshold for normal operation
  private currentVadThreshold = 0.01; // Dynamic threshold that increases during TTS
  private readonly vadHangoverMs = 1500; // Reduced for faster response
  private vadConsecutiveFrames = 0; // Count consecutive frames above threshold
  private readonly vadMinFrames = 3; // Reduced for faster response
  private recentRmsValues: number[] = []; // Track recent RMS values for adaptive threshold

  async initialize(): Promise<boolean> {
    try {
      // Initialize audio context
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      // Initialize VAD state
      this.isPlayingTTS = false;
      console.log('ProductionAudioManager: Initializing audio system');
      
      // Request microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true, // Enable noise suppression for cleaner audio
          autoGainControl: true,
          sampleRate: 48000
        }
      });

      // Set up mic gain, analyser, and recording destination for VAD + boosted recording
      try {
        if (this.audioContext) {
          const rawSource = this.audioContext.createMediaStreamSource(this.mediaStream);
          this.micGainNode = this.audioContext.createGain();
          this.micGainNode.gain.value = this.micBoostFactor;

          this.analyserNode = this.audioContext.createAnalyser();
          this.analyserNode.fftSize = 1024;
          this.analyserNode.smoothingTimeConstant = 0.6;

          const destination = this.audioContext.createMediaStreamDestination();

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
                console.log(`🎤 VAD: SPEECH DETECTED (rms=${rms.toFixed(3)}, frames=${this.vadConsecutiveFrames}, threshold=${this.currentVadThreshold.toFixed(3)})`);
                
                // If user starts speaking during TTS, interrupt it
                if (this.isPlayingTTS && this.isPlaying) {
                  console.log('🛑 VAD: User interrupted TTS - stopping playback');
                  this.isInterrupted = true;
                  this.stopPlayback();
                  
                  // Notify backend about interruption immediately
                  if (this.onPlaybackComplete) {
                    this.onPlaybackComplete();
                  }
                }
                
                // Notify UI for visual feedback
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
    if (!this.recordingStream) {
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

    this.mediaRecorder = new MediaRecorder(this.recordingStream, options);
    
    // Provide audio chunks continuously while recording
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0 && this.onAudioData) {
        // Always send audio data - let backend handle state management
        // Log occasionally to verify audio is being sent
        if (Math.random() < 0.05) {
          console.log(`MediaRecorder sending: ${event.data.size} bytes (TTS playing: ${this.isPlayingTTS})`);
        }
        event.data.arrayBuffer().then((buf) => {
          this.onAudioData!(buf);
        });
      }
    };

    // Start recording with smaller chunks for better STT accuracy
    try {
      this.mediaRecorder.start(100); // Reduced from 250ms to 100ms for better STT accuracy
      console.log('MediaRecorder started with 100ms timeslice - continuous audio streaming enabled');
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
    if (!this.audioContext) {
      console.error('Audio context not initialized');
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
        const audioBuffer = await this.audioContext.decodeAudioData(audioData.slice(0));
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
  private readonly PCM_ACCUMULATION_TIME = 800; // ms - accumulate for 800ms chunks for very smooth audio

  /**
   * Accumulate PCM chunks for smoother playback
   */
  private playPCMChunkImmediately(audioData: ArrayBuffer): void {
    if (!this.audioContext) return;
    
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
      
      // If accumulator gets too large (>1200ms worth), flush immediately
      const totalSamples = this.pcmAccumulator.reduce((sum, chunk) => sum + chunk.length, 0);
      const durationMs = (totalSamples / 24000) * 1000;
      
      if (durationMs > 1200) { // More than 1200ms accumulated
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
    if (this.pcmAccumulator.length === 0 || !this.audioContext) return;
    
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
      const audioBuffer = this.audioContext.createBuffer(1, combinedSamples.length, 24000);
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
      }, 200); // Reduced delay for faster response
      return;
    }

    this.isPlaying = true;
    const audioBuffer = this.audioQueue.shift()!;
    
    console.log(`ProductionAudioManager: Playing audio buffer ${audioBuffer.duration.toFixed(3)}s (${this.audioQueue.length} remaining)`);
    
    if (this.audioContext) {
      this.currentSource = this.audioContext.createBufferSource();
      this.currentSource.buffer = audioBuffer;
      
      // Add gain for better volume
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 1.5;
      
      this.currentSource.connect(gainNode);
      gainNode.connect(this.audioContext.destination);
      
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

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.mediaRecorder = null;
    this.onAudioData = null;
    this.onPlaybackComplete = null;
    
    console.log('Audio manager cleaned up');
  }
}

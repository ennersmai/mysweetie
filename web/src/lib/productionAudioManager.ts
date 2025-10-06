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
  private readonly micBoostFactor = 4.0; // Increased from 2.5 for better pickup
  private micMuted = false; // Track if mic should be muted during TTS playback

  // Simple VAD
  private analyserNode: AnalyserNode | null = null;
  private vadIntervalId: number | null = null;
  private vadSpeaking = false;
  private vadLastAboveThreshold = 0;
  private readonly vadThresholdRms = 0.003; // More sensitive - lowered from 0.006
  private readonly vadHangoverMs = 1500; // Longer hangover to avoid cutting words

  async initialize(): Promise<boolean> {
    try {
      // Initialize audio context
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      // Ensure mic starts unmuted
      this.micMuted = false;
      console.log('ProductionAudioManager: Initializing with micMuted =', this.micMuted);
      
      // Request microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false, // Disabled to preserve more audio detail
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
            
            // Skip VAD if mic is muted during TTS playback
            if (this.micMuted) {
              // Log once per mute cycle
              if (this.vadSpeaking) {
                this.vadSpeaking = false;
                console.log('VAD: Force-stopped speaking due to TTS playback');
                if (this.onSpeechEnd) {
                  this.onSpeechEnd();
                }
                try {
                  if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                    this.mediaRecorder.stop();
                    console.log('MediaRecorder stopped due to TTS playback');
                  }
                } catch (err) {
                  console.warn('Failed to stop MediaRecorder during TTS:', err);
                }
              }
              return; // Skip VAD processing during playback
            }
            
            // Log VAD activity every 100 cycles to debug
            if (Math.random() < 0.01) {
              console.log(`VAD active: rms=${rms.toFixed(4)}, threshold=${this.vadThresholdRms}, micMuted=${this.micMuted}`);
            }
            
            if (rms >= this.vadThresholdRms) {
              this.vadLastAboveThreshold = now;
              if (!this.vadSpeaking) {
                this.vadSpeaking = true;
                // eslint-disable-next-line no-console
                console.log(`VAD: speaking detected (rms=${rms.toFixed(3)})`);
                // Notify UI immediately
                if (this.onSpeechStart) {
                  this.onSpeechStart();
                }
                // Start recording this utterance if not already
                try {
                  if (this.mediaRecorder && this.mediaRecorder.state === 'inactive') {
                    // Start with 100ms timeslice to get continuous audio chunks
                    this.mediaRecorder.start(100);
                    console.log('MediaRecorder started for utterance with 100ms timeslice');
                  }
                } catch (err) {
                  console.warn('Failed to start MediaRecorder on VAD start:', err);
                }
              }
            } else if (this.vadSpeaking && now - this.vadLastAboveThreshold > this.vadHangoverMs) {
              this.vadSpeaking = false;
              // eslint-disable-next-line no-console
              console.log(`VAD: speaking ended`);
              // Notify UI
              if (this.onSpeechEnd) {
                this.onSpeechEnd();
              }
              // Finalize blob for this utterance
              try {
                if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                  this.mediaRecorder.stop();
                  console.log('MediaRecorder stopped to finalize utterance');
                }
              } catch (err) {
                console.warn('Failed to stop MediaRecorder on VAD end:', err);
              }
            }
          };
          this.vadIntervalId = window.setInterval(tick, 20); // Increased polling rate from 50ms to 20ms for faster response
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

    // Determine best supported format - increased bitrate for better quality
    const options: MediaRecorderOptions = {
      audioBitsPerSecond: 256000 // Increased from 192000 for clearer audio
    };
    
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      options.mimeType = 'audio/webm;codecs=opus';
    } else if (MediaRecorder.isTypeSupported('audio/webm')) {
      options.mimeType = 'audio/webm';
    }

    this.mediaRecorder = new MediaRecorder(this.recordingStream, options);
    
    // Provide finalized blob when recording stops; VAD controls start/stop
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0 && this.onAudioData) {
        event.data.arrayBuffer().then((buf) => this.onAudioData!(buf));
      }
    };

    console.log('Recording ready');
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
    
    // Mute mic during TTS playback to prevent echo
    this.micMuted = true;

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
      console.log(`ProductionAudioManager: About to check callback - hasCallback: ${!!this.onPlaybackComplete}, isPlaying: ${this.isPlaying}`);
      
      // Notify playback complete after a longer delay to ensure all audio has actually finished
      // This prevents the system from listening again while audio artifacts are still playing
        setTimeout(() => {
          console.log(`ProductionAudioManager: Timeout callback executing - hasCallback: ${!!this.onPlaybackComplete}, isPlaying: ${this.isPlaying}`);
          // Unmute mic now that TTS is complete
          this.micMuted = false;
          console.log('ProductionAudioManager: Mic unmuted, ready to listen');
          
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
        }, 300); // Increased from 100ms to 300ms to ensure audio fully finishes before listening
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
      this.currentSource.stop();
      this.currentSource = null;
    }
    
    // Clear audio queue and PCM buffer
    this.audioQueue = [];
    this.isPlaying = false;
    
    console.log('Playback stopped');
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

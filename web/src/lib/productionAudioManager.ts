/**
 * Production-Ready Audio Manager for Voice Calls
 * 
 * AudioWorklet-based implementation with ring buffer for zero first-word loss.
 * Outputs 16kHz WAV files optimized for Groq STT.
 */

export class ProductionAudioManager {
  private recordingContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioQueue: AudioBuffer[] = [];
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private onPlaybackComplete: (() => void) | null = null;
  private onSpeechStart: (() => void) | null = null;
  private onSpeechEnd: (() => void) | null = null;
  private onInterrupt: (() => void) | null = null;
  private onCalibrationChunk: ((chunk: ArrayBuffer) => void) | null = null;
  private isCalibrating = false;
  private isPlayingTTS = false;
  private isSendingAudio = false;
  private manuallyStoppedPlayback = false;
  private ttsStartTime = 0; // Track when TTS started for grace period
  private playbackPlayhead = 0; // Scheduled playback time for seamless transitions
  private lastGainNode: GainNode | null = null; // For crossfading
  private readonly CROSSFADE_DURATION = 0.01; // 10ms crossfade between buffers

  // AudioWorklet components
  private workletNode: AudioWorkletNode | null = null;
  
  // WebRTC loopback for native echo cancellation
  private loopbackPeerConnection: RTCPeerConnection | null = null;
  private webrtcDestination: MediaStreamAudioDestinationNode | null = null;
  private processedMicStream: MediaStream | null = null;
  private ringBuffer: Float32Array[] = [];
  private readonly RING_BUFFER_SIZE = 350; // ~933ms pre-roll at 48kHz (128 samples per chunk @ 20ms)
  private utteranceBuffer: Float32Array[] = [];
  private finalAudioBlob: Blob | null = null;

  // VAD state
  private vadSpeaking = false;
  private vadLastAboveThreshold = 0;
  private baseVadThreshold = 0.1; // Higher threshold to avoid false triggers from background noise
  private currentVadThreshold = 0.1;
  private readonly vadHangoverMs = 800;
  private vadConsecutiveFrames = 0;
  private readonly vadMinFrames = 2; // Responsive to speech
  private readonly micBoostFactor = 5.0; // Higher mic boost for better detection
  
  // Noise floor detection
  private noiseFloor = 0.005; // Minimum RMS to consider as potential speech
  private noiseFloorSamples: number[] = [];
  private readonly NOISE_FLOOR_SAMPLES = 50; // Samples to calculate noise floor

  // PCM accumulation for TTS playback
  private pcmAccumulator: Int16Array[] = [];
  private pcmAccumulatorTimer: number | null = null;
  private readonly PCM_ACCUMULATION_TIME = 500; // Increased from 200ms to 500ms to reduce static noise
  private readonly PCM_MIN_SAMPLES = 8000; // ~500ms at 16kHz, ~333ms at 24kHz - minimum samples before flushing
  private pcmCarryByte: number | null = null; // Carry byte for odd-length buffers

  async initialize(): Promise<boolean> {
    try {
      console.log('ProductionAudioManager: Initializing AudioWorklet-based audio system');
      
      // Request microphone access with explicit echo cancellation
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false, // Disabled to prevent amplifying TTS echo
          sampleRate: 48000
        }
      });

      // Verify and log what constraints were actually applied
      const track = this.mediaStream.getAudioTracks()[0];
      const settings = track.getSettings();
      
      console.log('🎤 Audio Track Settings:', {
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount
      });
      
      if (!settings.echoCancellation) {
        console.warn('⚠️ WARNING: Echo cancellation is NOT enabled!');
      } else {
        console.log('✅ Echo cancellation is ENABLED');
      }

      // Create separate playback context at 16kHz to match TTS output (Resemble.ai outputs at 16kHz)
      // This avoids resampling artifacts and pitch issues
      this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      console.log('ProductionAudioManager: Playback context created at', this.playbackContext.sampleRate, 'Hz');

      // Create recording context at browser's native sample rate (usually 48kHz)
      this.recordingContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      console.log('ProductionAudioManager: Recording context created at', this.recordingContext.sampleRate, 'Hz');

      // Try WebRTC loopback for native echo cancellation (may not work in all browsers)
      // If it fails, fall back to raw mic with browser's built-in AEC
      try {
        await this.setupWebRTCLoopback();
      } catch (error) {
        console.warn('⚠️ WebRTC loopback setup failed, using raw mic with browser AEC:', error);
      }

      // Load audio worklet for processing audio stream
      await this.recordingContext.audioWorklet.addModule('/audio-processor.js');
      console.log('✅ Audio processor loaded');

      // Create audio worklet node for processing audio
      this.workletNode = new AudioWorkletNode(this.recordingContext, 'audio-processor');

      // Connect microphone stream to worklet
      // Use processed stream if available (from WebRTC loopback), otherwise use raw mic
      // Browser's built-in AEC (via getUserMedia) should still work on raw mic
      if (this.processedMicStream && this.processedMicStream.getAudioTracks().length > 0) {
        const processedSource = this.recordingContext.createMediaStreamSource(this.processedMicStream);
        processedSource.connect(this.workletNode);
        console.log('✅ Connected processed mic stream (with native AEC) to worklet');
      } else {
        console.log('ℹ️ Using raw mic stream (browser AEC enabled via getUserMedia)');
        // Use raw mic stream - browser's AEC is already enabled via getUserMedia constraints
        const source = this.recordingContext.createMediaStreamSource(this.mediaStream);
        source.connect(this.workletNode);
      }

      // Handle incoming processed audio from worklet
      this.workletNode.port.onmessage = (event) => {
        // Processed PCM data (already echo-cancelled by browser's native AEC)
        const pcmData: Float32Array = event.data;
        
        // Debug: Log audio data occasionally to verify we're receiving audio
        if (Math.random() < 0.01) {
          // Calculate RMS to check if audio is actually present
          let sum = 0;
          for (let i = 0; i < pcmData.length; i++) {
            sum += pcmData[i] * pcmData[i];
          }
          const rms = Math.sqrt(sum / pcmData.length);
          console.log(`🎤 Audio data received: ${pcmData.length} samples, RMS=${rms.toFixed(6)}, calibrating=${this.isCalibrating}`);
        }
        
        // Always maintain ring buffer (last ~1200ms of audio)
        this.ringBuffer.push(pcmData);
        if (this.ringBuffer.length > this.RING_BUFFER_SIZE) {
          this.ringBuffer.shift();
        }
        
        // Debug: Log ring buffer status occasionally
        if (Math.random() < 0.001) {
          console.log(`🔍 Ring buffer status: ${this.ringBuffer.length}/${this.RING_BUFFER_SIZE} chunks, TTS playing: ${this.isPlayingTTS}`);
        }
        
        // Ensure recording context stays active during TTS
        if (this.recordingContext && this.recordingContext.state === 'suspended') {
          console.log('🔧 Resuming suspended recording context');
          this.recordingContext.resume();
        }
        
        // During calibration, send audio chunks directly without VAD processing
        if (this.isCalibrating && this.onCalibrationChunk) {
          // Convert Float32Array to Int16Array PCM for calibration
          const int16Data = new Int16Array(pcmData.length);
          for (let i = 0; i < pcmData.length; i++) {
            // Clamp to [-1, 1] and convert to 16-bit integer
            const sample = Math.max(-1, Math.min(1, pcmData[i]));
            int16Data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
          }
          this.onCalibrationChunk(int16Data.buffer);
          return; // Skip VAD processing during calibration
        }
        
        // Run VAD on this chunk
        this.runVadOnPcm(pcmData);
        
        // If actively recording speech, accumulate in utterance buffer
        if (this.isSendingAudio) {
          this.utteranceBuffer.push(pcmData);
        }
      };

      console.log('✅ Audio processing pipeline configured');

      return true;
    } catch (error) {
      console.error('Failed to initialize audio:', error);
      return false;
    }
  }

  /**
   * Set up WebRTC loopback for native echo cancellation
   * This leverages the browser's built-in, hardware-accelerated AEC
   */
  private async setupWebRTCLoopback(): Promise<void> {
    if (!this.playbackContext || !this.recordingContext || !this.mediaStream) {
      throw new Error('Cannot setup WebRTC loopback - contexts not initialized');
    }

    console.log('🔄 Setting up WebRTC loopback for native echo cancellation...');

    // Create MediaStreamDestination node for TTS audio output
    // This will be used as the reference signal for echo cancellation
    this.webrtcDestination = this.playbackContext.createMediaStreamDestination();
    console.log('✅ Created WebRTC destination for TTS audio');

    // Create loopback RTCPeerConnection
    this.loopbackPeerConnection = new RTCPeerConnection({
      iceServers: [] // No ICE servers needed for loopback
    });

    // Add TTS audio track (reference signal) to peer connection
    const ttsTracks = this.webrtcDestination.stream.getAudioTracks();
    ttsTracks.forEach(track => {
      this.loopbackPeerConnection!.addTrack(track, this.webrtcDestination!.stream);
      console.log('✅ Added TTS audio track to peer connection');
    });

    // Add microphone track (with AEC enabled) to peer connection
    const micTracks = this.mediaStream.getAudioTracks();
    micTracks.forEach(track => {
      this.loopbackPeerConnection!.addTrack(track, this.mediaStream!);
      console.log('✅ Added microphone track to peer connection');
    });

    // Set up handler for processed audio stream (with native AEC applied)
    this.processedMicStream = new MediaStream();
    
    // Promise to wait for the processed track
    let trackReceived = false;
    const trackPromise = new Promise<void>((resolve) => {
      this.loopbackPeerConnection!.ontrack = (event) => {
        // The ontrack event fires for remote tracks
        // In our loopback, this is the microphone audio AFTER native AEC processing
        if (event.track.kind === 'audio' && !trackReceived) {
          // Check if track is actually enabled and not muted
          if (event.track.enabled && !event.track.muted) {
            this.processedMicStream!.addTrack(event.track);
            trackReceived = true;
            console.log('✅ Received processed microphone track (with native AEC)', {
              enabled: event.track.enabled,
              muted: event.track.muted,
              readyState: event.track.readyState,
              id: event.track.id
            });
            resolve();
          } else {
            console.warn('⚠️ Received track but it is disabled or muted', {
              enabled: event.track.enabled,
              muted: event.track.muted
            });
          }
        }
      };
    });

    // Complete the loopback by creating offer/answer
    // We loop back to ourselves, so we use the same offer as both local and remote
    const offer = await this.loopbackPeerConnection.createOffer();
    await this.loopbackPeerConnection.setLocalDescription(offer);
    await this.loopbackPeerConnection.setRemoteDescription(offer);
    
    // Wait for the processed track to be received (with timeout)
    await Promise.race([
      trackPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2000)) // 2 second timeout
    ]);
    
    if (!trackReceived) {
      console.warn('⚠️ Processed mic track not received - will use raw mic stream');
      // Try to get receivers as fallback
      const receivers = this.loopbackPeerConnection.getReceivers();
      console.log(`🔍 Found ${receivers.length} receivers in peer connection`);
      receivers.forEach((receiver, idx) => {
        if (receiver.track && receiver.track.kind === 'audio') {
          console.log(`🔍 Receiver ${idx}: track enabled=${receiver.track.enabled}, muted=${receiver.track.muted}, readyState=${receiver.track.readyState}`);
          if (!this.processedMicStream!.getAudioTracks().some(t => t.id === receiver.track.id)) {
            this.processedMicStream!.addTrack(receiver.track);
            trackReceived = true;
            console.log('✅ Added track from receiver');
          }
        }
      });
    }
    
    console.log('✅ WebRTC loopback established - native AEC active', {
      processedStreamTracks: this.processedMicStream.getAudioTracks().length,
      trackReceived
    });
  }


  /**
   * VAD analysis on raw PCM data
   */
  private runVadOnPcm(pcmData: Float32Array): void {
    // Calculate RMS with mic boost
    let sum = 0;
    for (let i = 0; i < pcmData.length; i++) {
      sum += pcmData[i] * pcmData[i];
    }
    const rms = Math.sqrt(sum / pcmData.length) * this.micBoostFactor;
    
    // Update noise floor detection (only when not speaking and not playing TTS)
    if (!this.vadSpeaking && !this.isPlayingTTS) {
      this.noiseFloorSamples.push(rms);
      if (this.noiseFloorSamples.length > this.NOISE_FLOOR_SAMPLES) {
        this.noiseFloorSamples.shift();
      }
      
      // Calculate adaptive noise floor (90th percentile of recent samples)
      if (this.noiseFloorSamples.length >= 20) {
        const sorted = [...this.noiseFloorSamples].sort((a, b) => a - b);
        const percentile90 = Math.floor(sorted.length * 0.9);
        this.noiseFloor = Math.max(0.005, sorted[percentile90] * 1.5); // 1.5x the 90th percentile
      }
    }
    
    const now = performance.now();
    
    // During TTS playback, use native AEC (via WebRTC loopback) for echo cancellation
    // Browser's native AEC should handle most echo, so we can use a moderate threshold
    if (this.isPlayingTTS) {
      // Short grace period to allow native AEC to adapt
      const timeSinceTTSStart = performance.now() - (this.ttsStartTime || 0);
      const gracePeriodMs = 300; // 300ms grace period for native AEC to adapt
      
      if (timeSinceTTSStart < gracePeriodMs) {
        // Skip VAD during initial adaptation period
        return;
      }
      
      // Use moderate threshold (2x) - native AEC should handle most echo
      // This allows normal barge-in while filtering residual echo
      this.currentVadThreshold = this.baseVadThreshold * 2.0; // Moderate threshold
    }
    
    // Check if RMS is above both threshold and noise floor
    const aboveThreshold = rms >= this.currentVadThreshold;
    const aboveNoiseFloor = rms >= this.noiseFloor;
    
    if (aboveThreshold && aboveNoiseFloor) {
      this.vadLastAboveThreshold = now;
      this.vadConsecutiveFrames++;
      
      // Same consecutive frames for both cases - responsive to speech
      const requiredFrames = this.vadMinFrames;
      
      // Only confirm speech after consecutive frames
      if (!this.vadSpeaking && this.vadConsecutiveFrames >= requiredFrames) {
        // Allow interrupts - don't block legitimate user speech
        
        this.vadSpeaking = true;
        const timestamp = performance.now();
        console.log(`🎤 VAD: SPEECH DETECTED at ${timestamp.toFixed(0)}ms (rms=${rms.toFixed(3)}, frames=${this.vadConsecutiveFrames}, threshold=${this.currentVadThreshold.toFixed(3)})`);
        
        // Check if this is an interrupt (user speaking during TTS)
        const isInterrupt = this.isPlayingTTS;
        
        // Initialize utterance buffer WITH ring buffer (captures first word!)
        this.utteranceBuffer = [...this.ringBuffer];
        this.isSendingAudio = true;
        console.log(`🎤 Speech started - initialized with ${this.ringBuffer.length} ring buffer chunks (pre-roll)`);
        
        // Handle interrupt
        if (isInterrupt) {
          console.log('🎤 Interrupt detected - stopping TTS playback');
          
          // Drop threshold IMMEDIATELY for tracking user's speech
          this.currentVadThreshold = this.baseVadThreshold;
          console.log(`🔧 VAD threshold dropped to normal (${this.currentVadThreshold.toFixed(4)})`);
          
          // Stop TTS playback
          this.stopPlayback();
          
          // Send explicit interrupt command to backend
          if (this.onInterrupt) {
            console.log('⚡ Sending interrupt command to backend');
            this.onInterrupt();
          }
        }
        
        // ALWAYS notify backend that user started speaking
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
        
        this.isSendingAudio = false;
        
        // Reset manual stop flag
        this.manuallyStoppedPlayback = false;
        console.log('🔓 Reset manuallyStoppedPlayback - ready for next AI response');
        
        // Concatenate all Float32Arrays into single array
        const totalLength = this.utteranceBuffer.reduce((sum, arr) => sum + arr.length, 0);
        const finalPcm = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of this.utteranceBuffer) {
          finalPcm.set(chunk, offset);
          offset += chunk.length;
        }
        
        console.log(`📦 Assembling ${this.utteranceBuffer.length} chunks (${totalLength} samples) into WAV`);
        
        // Convert to 16kHz WAV
        const sampleRate = this.recordingContext?.sampleRate || 48000;
        const wavBlob = this.pcmToWav16k(finalPcm, sampleRate);
        
        // Store for sending
        this.finalAudioBlob = wavBlob;
        
        // Clear buffer
        this.utteranceBuffer = [];
        
        console.log(`✅ WAV file ready: ${wavBlob.size} bytes`);
        
        // Call callback
        if (this.onSpeechEnd) {
          this.onSpeechEnd();
        }
      }
    }
  }

  /**
   * Convert Float32 PCM to 16kHz WAV with downsampling
   */
  private pcmToWav16k(pcm48k: Float32Array, sampleRate: number): Blob {
    // Downsample 48kHz → 16kHz
    const targetRate = 16000;
    const ratio = sampleRate / targetRate;
    const outputLength = Math.floor(pcm48k.length / ratio);
    const pcm16k = new Float32Array(outputLength);
    
    // Linear interpolation downsampling (better quality than simple decimation)
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, pcm48k.length - 1);
      const fraction = srcIndex - srcIndexFloor;
      
      if (srcIndexFloor < pcm48k.length) {
        pcm16k[i] = pcm48k[srcIndexFloor] * (1 - fraction) + 
                     pcm48k[srcIndexCeil] * fraction;
      }
    }
    
    console.log(`🔄 Downsampled ${pcm48k.length} samples @ ${sampleRate}Hz → ${pcm16k.length} samples @ ${targetRate}Hz (linear interpolation)`);
    
    // Convert float32 (-1 to 1) → int16 (-32768 to 32767)
    const int16Data = new Int16Array(pcm16k.length);
    for (let i = 0; i < pcm16k.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm16k[i]));
      int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    // Create WAV header
    const wavHeader = this.createWavHeader(int16Data.length * 2, targetRate, 1);
    
    // Combine header + data
    return new Blob([wavHeader, int16Data], { type: 'audio/wav' });
  }

  /**
   * Create standard WAV header
   */
  private createWavHeader(dataLength: number, sampleRate: number, channels: number): ArrayBuffer {
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);
    
    // "RIFF" chunk descriptor
    view.setUint32(0, 0x52494646, false); // "RIFF" = 0x52('R') 49('I') 46('F') 46('F')
    view.setUint32(4, 36 + dataLength, true); // File size - 8
    view.setUint32(8, 0x57415645, false); // "WAVE" = 0x57('W') 41('A') 56('V') 45('E')
    
    // "fmt " sub-chunk
    view.setUint32(12, 0x666d7420, false); // "fmt " = 0x66('f') 6d('m') 74('t') 20(' ')
    view.setUint32(16, 16, true); // Subchunk size (16 for PCM)
    view.setUint16(20, 1, true); // Audio format (1 = PCM)
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true); // Byte rate
    view.setUint16(32, channels * 2, true); // Block align
    view.setUint16(34, 16, true); // Bits per sample
    
    // "data" sub-chunk
    view.setUint32(36, 0x64617461, false); // "data" = 0x64('d') 61('a') 74('t') 61('a')
    view.setUint32(40, dataLength, true);
    
    return buffer;
  }

  startRecording(): boolean {
    if (!this.workletNode) {
      console.error('AudioWorklet not initialized - worklet node not ready');
      return false;
    }

    console.log('✅ Recording ready and active (Echo cancellation AudioWorklet processing)');
    return true;
  }

  stopRecording(): void {
    console.log('Recording stopped');
  }

  /**
   * Play audio data (handles both PCM and encoded formats)
   */
  async playAudio(audioData: ArrayBuffer): Promise<void> {
    if (!this.playbackContext) {
      console.error('Playback context not initialized');
      return;
    }
    
    // CRITICAL: If playback was manually stopped, reject ALL new audio
    if (this.manuallyStoppedPlayback) {
      console.log('🛑 Rejecting audio - playback was manually stopped by user interrupt');
      return;
    }
    
    // Set TTS playing state ONLY if not already playing
    if (!this.isPlayingTTS) {
      console.log('🎵 Starting TTS playback session - echo cancellation active, VAD threshold increased');
      this.isPlayingTTS = true;
      this.ttsStartTime = performance.now(); // Track start time for grace period
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
        const audioBuffer = await this.playbackContext.decodeAudioData(audioData.slice(0));
        console.log(`ProductionAudioManager: Decoded audio buffer ${audioBuffer.duration.toFixed(2)}s`);
        this.audioQueue.push(audioBuffer);
        
        if (!this.isPlaying) {
          this.playNextInQueue();
        }
      }
    } catch (error) {
      console.error('Error processing audio:', error);
    }
  }

  private playPCMChunkImmediately(audioData: ArrayBuffer): void {
    if (!this.playbackContext) return;
    
    try {
      // Handle odd-length buffers by carrying over the last byte
      let buffer = new Uint8Array(audioData);
      
      // If we have a carry byte from previous chunk, prepend it
      if (this.pcmCarryByte !== null) {
        const merged = new Uint8Array(buffer.length + 1);
        merged[0] = this.pcmCarryByte;
        merged.set(buffer, 1);
        buffer = merged;
        this.pcmCarryByte = null;
      }
      
      // If buffer length is odd, save the last byte for next chunk
      if (buffer.length % 2 === 1) {
        this.pcmCarryByte = buffer[buffer.length - 1];
        buffer = buffer.subarray(0, buffer.length - 1);
      }
      
      // Create Int16Array from aligned buffer (must be multiple of 2)
      if (buffer.length === 0) {
        return; // Nothing to process
      }
      
      const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
      
      // Add to accumulator
      this.pcmAccumulator.push(samples);
      
      // Reset timer
      if (this.pcmAccumulatorTimer) {
        clearTimeout(this.pcmAccumulatorTimer);
      }
      
      // Calculate total samples accumulated
      const totalSamples = this.pcmAccumulator.reduce((sum, chunk) => sum + chunk.length, 0);
      
      // Only flush if we have minimum samples OR if buffer is getting too large
      // TTS outputs at 16kHz, so calculate duration based on that
      const durationMs = (totalSamples / 16000) * 1000;
      const shouldFlush = totalSamples >= this.PCM_MIN_SAMPLES || durationMs > 800;
      
      if (shouldFlush) {
        // Flush immediately if we have enough samples
        if (this.pcmAccumulatorTimer) {
          clearTimeout(this.pcmAccumulatorTimer);
          this.pcmAccumulatorTimer = null;
        }
        this.flushPCMAccumulator();
      } else {
        // Set timer to flush accumulator after accumulation time
        this.pcmAccumulatorTimer = window.setTimeout(() => {
          this.flushPCMAccumulator();
        }, this.PCM_ACCUMULATION_TIME);
      }
      
    } catch (error) {
      console.error('Error accumulating PCM chunk:', error);
      // Reset carry byte on error
      this.pcmCarryByte = null;
    }
  }

  private flushPCMAccumulator(): void {
    if (this.pcmAccumulator.length === 0 || !this.playbackContext) {
      // Clear timer if accumulator is empty
      if (this.pcmAccumulatorTimer) {
        clearTimeout(this.pcmAccumulatorTimer);
        this.pcmAccumulatorTimer = null;
      }
      return;
    }
    
    try {
      // Combine all accumulated chunks
      const totalLength = this.pcmAccumulator.reduce((sum, chunk) => sum + chunk.length, 0);
      
      // Only flush if we have minimum samples (unless forced)
      if (totalLength < this.PCM_MIN_SAMPLES) {
        // Don't flush yet, wait for more samples
        return;
      }
      
      const combinedSamples = new Int16Array(totalLength);
      
      let offset = 0;
      for (const chunk of this.pcmAccumulator) {
        combinedSamples.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Create single smooth audio buffer
      // TTS outputs at 16kHz, so we need to use 16kHz sample rate to avoid pitch issues
      const audioBuffer = this.playbackContext.createBuffer(1, combinedSamples.length, 16000);
      const channelData = audioBuffer.getChannelData(0);
      
      for (let i = 0; i < combinedSamples.length; i++) {
        channelData[i] = combinedSamples[i] / 32768.0;
      }
      
      console.log(`📦 Flushed ${this.pcmAccumulator.length} PCM chunks (${totalLength} samples) → ${audioBuffer.duration.toFixed(3)}s buffer added to queue (queue length: ${this.audioQueue.length + 1})`);
      
      // Clear accumulator
      this.pcmAccumulator = [];
      this.pcmAccumulatorTimer = null;
      
      // Add to playback queue
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
      this.pcmCarryByte = null; // Reset carry byte on error
    }
  }

  flushRemainingPCM(): void {
    console.log('🔚 TTS sentence complete - flushing remaining PCM accumulator');
    if (this.pcmAccumulatorTimer) {
      clearTimeout(this.pcmAccumulatorTimer);
      this.pcmAccumulatorTimer = null;
    }
    
    // Force flush even if below minimum samples
    const totalLength = this.pcmAccumulator.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalLength === 0 || !this.playbackContext) {
      this.pcmCarryByte = null;
      return;
    }
    
    try {
      // Combine all accumulated chunks (force flush regardless of minimum)
      const combinedSamples = new Int16Array(totalLength);
      
      let offset = 0;
      for (const chunk of this.pcmAccumulator) {
        combinedSamples.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Create single smooth audio buffer
      // TTS outputs at 16kHz, so we need to use 16kHz sample rate to avoid pitch issues
      const audioBuffer = this.playbackContext.createBuffer(1, combinedSamples.length, 16000);
      const channelData = audioBuffer.getChannelData(0);
      
      for (let i = 0; i < combinedSamples.length; i++) {
        channelData[i] = combinedSamples[i] / 32768.0;
      }
      
      console.log(`📦 Final flush: ${this.pcmAccumulator.length} PCM chunks (${totalLength} samples) → ${audioBuffer.duration.toFixed(3)}s buffer`);
      
      // Clear accumulator
      this.pcmAccumulator = [];
      
      // Add to playback queue
      this.audioQueue.push(audioBuffer);
      
      // Start playback if not already playing
      if (!this.isPlaying) {
        console.log('🎵 Queue was idle, starting playback');
        this.playNextInQueue();
      }
      
    } catch (error) {
      console.error('Error flushing remaining PCM:', error);
      this.pcmAccumulator = [];
    }
    
    // Clear carry byte on final flush
    this.pcmCarryByte = null;
  }

  private isPCMData(data: ArrayBuffer): boolean {
    const view = new DataView(data);
    if (data.byteLength < 4) return true;
    
    const signature = view.getUint32(0, false);
    const isWebM = signature === 0x1a45dfa3;
    const isOgg = signature === 0x4f676753;
    const isWav = signature === 0x52494646;
    
    return !isWebM && !isOgg && !isWav;
  }

  private playNextInQueue(): void {
    if (this.audioQueue.length === 0) {
      console.log('✅ Audio queue empty - no more buffers to play');
      return;
    }

    if (!this.playbackContext) {
      return;
    }

    // CRITICAL: Set isPlaying = true SYNCHRONOUSLY
    this.isPlaying = true;
    this.manuallyStoppedPlayback = false;
    
    const audioBuffer = this.audioQueue.shift()!;
    const currentTime = this.playbackContext.currentTime;
    
    // Calculate start time for seamless playback
    let startTime: number;
    if (this.playbackPlayhead === 0) {
      // First buffer - start immediately
      startTime = currentTime + 0.01; // Small delay to ensure scheduling
    } else {
      // Subsequent buffers - start slightly before previous ends for crossfade
      startTime = this.playbackPlayhead - this.CROSSFADE_DURATION;
      // Ensure we don't schedule in the past
      if (startTime < currentTime) {
        startTime = currentTime + 0.01;
        this.playbackPlayhead = startTime; // Reset playhead if we had to adjust
      }
    }
    
    const endTime = startTime + audioBuffer.duration;
    this.playbackPlayhead = endTime;
    
    console.log(`▶️  Playing buffer ${audioBuffer.duration.toFixed(3)}s at ${startTime.toFixed(3)}s (isPlaying: ${this.isPlaying}, ${this.audioQueue.length} remaining in queue)`);
    
    this.currentSource = this.playbackContext.createBufferSource();
    this.currentSource.buffer = audioBuffer;
    
    const gainNode = this.playbackContext.createGain();
    
    // Apply crossfade if there's a previous buffer
    if (this.lastGainNode) {
      // Fade out previous buffer during crossfade period
      try {
        const fadeStart = Math.max(currentTime, startTime - this.CROSSFADE_DURATION);
        this.lastGainNode.gain.setValueAtTime(1.5, fadeStart);
        this.lastGainNode.gain.linearRampToValueAtTime(0, startTime);
      } catch (e) {
        // Ignore scheduling errors
      }
      
      // Fade in new buffer from start
      try {
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(1.5, startTime + this.CROSSFADE_DURATION);
      } catch (e) {
        // Fallback if scheduling fails
        gainNode.gain.value = 1.5;
      }
    } else {
      // First buffer - no crossfade needed
      gainNode.gain.value = 1.5;
    }
    
    this.currentSource.connect(gainNode);
    
    // Route TTS audio through WebRTC destination for native echo cancellation
    // Also connect to regular destination for playback
    if (this.webrtcDestination) {
      // Connect to WebRTC destination (for echo cancellation reference)
      gainNode.connect(this.webrtcDestination);
    }
    // Always connect to regular destination for playback
    gainNode.connect(this.playbackContext.destination);
    
    // Store gain node for next crossfade
    this.lastGainNode = gainNode;
    
    this.currentSource.onended = () => {
      console.log(`✓ Buffer finished playing (isPlayingTTS: ${this.isPlayingTTS})`);
      this.currentSource = null;
      
      if (this.manuallyStoppedPlayback) {
        console.log('🛑 Ignoring onended (playback was manually stopped)');
        return;
      }
      
      if (this.audioQueue.length > 0) {
        console.log(`⏭️  More buffers in queue (${this.audioQueue.length}), playing next`);
        this.playNextInQueue();
      } else {
        console.log('🏁 Last buffer finished, queue empty - setting isPlaying = false');
        this.isPlaying = false;
        this.playbackPlayhead = 0; // Reset playhead
        this.lastGainNode = null; // Clear gain node reference
        
        // Only clear isPlayingTTS and notify completion if TTS session is actually done
        // Keep isPlayingTTS=true if more audio might be coming
        if (this.isPlayingTTS) {
          // Wait a bit to see if more audio arrives before clearing TTS state
          setTimeout(() => {
            if (this.audioQueue.length === 0 && !this.isPlaying && this.isPlayingTTS) {
              console.log('✅ TTS session complete - no more audio after delay, re-enabling VAD');
              this.isPlayingTTS = false;
              this.ttsStartTime = 0; // Reset TTS start time
              if (this.onPlaybackComplete) {
                this.onPlaybackComplete();
              }
            }
          }, 200); // 200ms delay to allow more audio to arrive
        } else if (this.onPlaybackComplete) {
          console.log('✅ Playback complete - notifying backend');
          this.onPlaybackComplete();
        }
      }
    };
    
    try {
      this.currentSource.start(startTime);
    } catch (error) {
      console.error('Error starting audio source:', error);
      // Fallback to immediate start if scheduling fails
      this.currentSource.start();
    }
  }

  stopPlayback(): void {
    this.manuallyStoppedPlayback = true;
    
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (error) {
        console.log('Source already stopped or error stopping:', error);
      }
      this.currentSource = null;
    }
    
    this.audioQueue = [];
    this.isPlaying = false;
    this.isPlayingTTS = false;
    this.ttsStartTime = 0; // Reset TTS start time
    this.playbackPlayhead = 0; // Reset playhead
    this.lastGainNode = null; // Clear gain node reference
    
    // Reset VAD state when playback stops
    this.vadSpeaking = false;
    this.vadConsecutiveFrames = 0;
    this.vadLastAboveThreshold = 0;
    this.currentVadThreshold = this.baseVadThreshold;
    console.log(`🔄 VAD state reset in stopPlayback - threshold: ${this.currentVadThreshold.toFixed(4)} (base: ${this.baseVadThreshold.toFixed(4)})`);
    
    if (this.pcmAccumulatorTimer) {
      clearTimeout(this.pcmAccumulatorTimer);
      this.pcmAccumulatorTimer = null;
    }
    this.pcmAccumulator = [];
    this.pcmCarryByte = null;
    
    // Note: Echo cancellation is handled by browser's native AEC via WebRTC loopback
    // No need to reset anything - browser handles it automatically
    
    console.log('🛑 Playback stopped and cleared');
  }

  setPlaybackCompleteCallback(callback: (() => void) | null): void {
    console.log('ProductionAudioManager: Setting playback complete callback:', callback ? 'SET' : 'NULL');
    this.onPlaybackComplete = callback;
  }

  public completeTTSSession(): void {
    console.log('🏁 TTS session complete signal received from backend');
    
    if (this.manuallyStoppedPlayback) {
      console.log('🛑 Ignoring completion (playback was manually stopped by user interrupt)');
      this.manuallyStoppedPlayback = false;
      return;
    }
    
    if (this.isPlayingTTS) {
      console.log('✅ Marking TTS session as complete, re-enabling VAD');
      this.isPlayingTTS = false;
      this.ttsStartTime = 0; // Reset TTS start time
      
      // Reset VAD state to ensure clean detection after TTS
      this.vadSpeaking = false;
      this.vadConsecutiveFrames = 0;
      this.vadLastAboveThreshold = 0;
      this.currentVadThreshold = this.baseVadThreshold; // Reset to normal threshold
      console.log(`🔄 VAD state reset after TTS completion - threshold: ${this.currentVadThreshold.toFixed(4)} (base: ${this.baseVadThreshold.toFixed(4)})`);
      
      // Note: Echo cancellation is handled by browser's native AEC via WebRTC loopback
      // No need to reset anything - browser handles it automatically
      
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

  /**
   * Set calibration callback for sending audio chunks during calibration
   */
  setCalibrationCallback(callback: ((chunk: ArrayBuffer) => void) | null): void {
    this.onCalibrationChunk = callback;
  }

  /**
   * Start calibration mode - audio chunks will be sent via calibration callback
   */
  startCalibration(): void {
    console.log('🎯 Starting VAD calibration mode');
    this.isCalibrating = true;
  }

  /**
   * Stop calibration mode
   */
  stopCalibration(): void {
    console.log('✅ Stopping VAD calibration mode');
    this.isCalibrating = false;
  }

  /**
   * Set VAD threshold (from backend calibration)
   * The backend threshold is in raw RMS energy units
   * Client-side multiplies RMS by micBoostFactor before comparison
   * So we need to multiply the backend threshold by micBoostFactor to match
   */
  setVADThreshold(backendThreshold: number): void {
    // Backend threshold is in raw RMS energy (0-1 range typically)
    // Client-side calculates: rms = rawRMS * micBoostFactor
    // So client threshold should be: backendThreshold * micBoostFactor
    const clientThreshold = backendThreshold * this.micBoostFactor;
    
    // Set as base threshold (will be used for normal listening)
    this.baseVadThreshold = Math.max(0.001, Math.min(0.5, clientThreshold)); // Clamp to reasonable range
    this.currentVadThreshold = this.baseVadThreshold;
    
    console.log(`🎯 VAD threshold updated from backend calibration: backend=${backendThreshold.toFixed(6)}, client=${this.baseVadThreshold.toFixed(4)} (multiplied by ${this.micBoostFactor}x)`);
  }

  getAssembledAudio(): Blob | null {
    if (!this.finalAudioBlob) {
      console.warn('⚠️ No audio to send');
      return null;
    }
    
    const blob = this.finalAudioBlob;
    this.finalAudioBlob = null; // Clear for next utterance
    
    console.log(`🎵 Returning assembled WAV: ${blob.size} bytes`);
    return blob;
  }

  cleanup(): void {
    this.stopRecording();
    this.stopPlayback();
    
    // Close WebRTC loopback connection
    if (this.loopbackPeerConnection) {
      this.loopbackPeerConnection.close();
      this.loopbackPeerConnection = null;
      console.log('✅ Closed WebRTC loopback connection');
    }
    
    this.vadSpeaking = false;
    this.vadLastAboveThreshold = 0;
    this.isSendingAudio = false;
    
    // Clear buffers
    this.ringBuffer = [];
    this.utteranceBuffer = [];
    this.finalAudioBlob = null;

    if (this.pcmAccumulatorTimer) {
      clearTimeout(this.pcmAccumulatorTimer);
      this.pcmAccumulatorTimer = null;
    }
    this.pcmAccumulator = [];
    this.pcmCarryByte = null;
    
    // Disconnect worklet
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode.port.onmessage = null;
      this.workletNode = null;
    }
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.recordingContext && this.recordingContext.state !== 'closed') {
      this.recordingContext.close();
      this.recordingContext = null;
    }

    if (this.playbackContext && this.playbackContext.state !== 'closed') {
      this.playbackContext.close();
      this.playbackContext = null;
    }

    this.onPlaybackComplete = null;
    
    console.log('Audio manager cleaned up');
  }
}

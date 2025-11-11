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
  private audioQueue: AudioBuffer[] = []; // Master queue of all audio buffers
  private scheduledBuffers: Array<{ source: AudioBufferSourceNode; endTime: number }> = []; // Currently scheduled buffers
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private queueManagerTimer: number | null = null; // Timer for smart queue management
  private readonly QUEUE_CHECK_INTERVAL = 250; // Check queue every 250ms
  private readonly TARGET_BUFFER_DURATION = 2.0; // Maintain 2 seconds of scheduled audio
  private onPlaybackComplete: (() => void) | null = null;
  private onSpeechStart: (() => void) | null = null;
  private onSpeechEnd: (() => void) | null = null;
  private onInterrupt: (() => void) | null = null;
  private onCalibrationChunk: ((chunk: ArrayBuffer) => void) | null = null;
  private isCalibrating = false;
  private isPlayingTTS = false;
  private isSendingAudio = false;
  private manuallyStoppedPlayback = false;
  private playbackPlayhead = 0; // Scheduled playback time for seamless transitions
  private lastGainNode: GainNode | null = null; // For crossfading
  private readonly CROSSFADE_DURATION = 0.01; // 10ms crossfade between buffers
  private readonly FADE_IN_DURATION = 0.01; // 10ms fade-in for first buffer to prevent crack/pop
  private isFirstBuffer = true; // Track if this is the first buffer of TTS session (for fade-in)

  // AudioWorklet components
  private workletNode: AudioWorkletNode | null = null; // VAD worklet
  private aecNode: AudioWorkletNode | null = null; // AEC worklet
  private ttsDestinationNode: MediaStreamAudioDestinationNode | null = null; // Captures TTS for AEC
  private ttsSourceNode: MediaStreamAudioSourceNode | null = null; // TTS source in recording context
  private ringBuffer: Float32Array[] = [];
  private readonly RING_BUFFER_SIZE = 350; // ~933ms pre-roll at 48kHz (128 samples per chunk @ 20ms)
  private utteranceBuffer: Float32Array[] = [];
  private finalAudioBlob: Blob | null = null;

  // VAD state (managed by worklet)
  private vadSpeaking = false;

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

      // Load AEC worklet first (imported as module, processed by Vite)
      // Use new URL() pattern - Vite will rewrite this at build time to the .js asset
      // Never hard-code the hashed asset path or .ts extension
      await this.recordingContext.audioWorklet.addModule(
        new URL('./aec-processor.ts', import.meta.url)
      );
      console.log('✅ AEC processor loaded');
      
      // Load audio worklet for simple VAD
      await this.recordingContext.audioWorklet.addModule('/audio-processor.js');
      console.log('✅ Audio processor (VAD) loaded');

      // Create AEC worklet node with 2 inputs (mic, TTS) and 1 output (clean audio)
      this.aecNode = new AudioWorkletNode(this.recordingContext, 'aec-processor', {
        numberOfInputs: 2,
        numberOfOutputs: 1
      });
      console.log('✅ AEC worklet node created');

      // Initialize AEC via message
      const aecInitPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('AEC initialization timeout'));
        }, 10000); // 10 second timeout
        
        this.aecNode!.port.onmessage = (event) => {
          if (event.data.type === 'init-done') {
            clearTimeout(timeout);
            console.log('✅ AEC initialized successfully');
            resolve();
          } else if (event.data.type === 'init-error') {
            clearTimeout(timeout);
            reject(new Error(`AEC initialization error: ${event.data.error}`));
          }
        };
      });

      // Send init message to AEC worklet
      this.aecNode.port.postMessage({
        type: 'init',
        sampleRate: this.recordingContext.sampleRate
      });

      // Wait for AEC initialization
      await aecInitPromise;

      // Create TTS destination node in playback context to capture TTS audio
      this.ttsDestinationNode = this.playbackContext.createMediaStreamDestination();
      console.log('✅ TTS destination node created');

      // Create TTS source node in recording context from TTS stream
      // This will auto-resample 16kHz → 48kHz
      this.ttsSourceNode = this.recordingContext.createMediaStreamSource(this.ttsDestinationNode.stream);
      console.log('✅ TTS source node created (auto-resampling 16kHz → 48kHz)');

      // Create VAD worklet node with single input (receives clean audio from AEC)
      this.workletNode = new AudioWorkletNode(this.recordingContext, 'audio-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1 // Pass-through output
      });
      console.log('✅ VAD worklet node created');

      // Build new audio chain:
      // micSource → AEC (input 0)
      // ttsSourceNode → AEC (input 1)
      // AEC → VAD worklet
      const micSource = this.recordingContext.createMediaStreamSource(this.mediaStream);
      micSource.connect(this.aecNode, 0, 0); // Mic to AEC input 0
      this.ttsSourceNode.connect(this.aecNode, 0, 1); // TTS to AEC input 1
      this.aecNode.connect(this.workletNode); // AEC output to VAD input
      console.log('✅ Audio chain configured: mic → AEC → VAD');

      // Handle messages from VAD worklet
      this.workletNode.port.onmessage = (event) => {
        const message = event.data;
        
        if (message.type === 'speech_start') {
          // VAD detected speech
          this.handleSpeechStart();
        } else if (message.type === 'speech_end') {
          // VAD detected speech end
          this.handleSpeechEnd();
        } else if (message.type === 'audio_data') {
          // Audio data from worklet (for ring buffer and recording)
          const pcmData: Float32Array = message.data;
          
          // Always maintain ring buffer (last ~1200ms of audio)
          this.ringBuffer.push(pcmData);
          if (this.ringBuffer.length > this.RING_BUFFER_SIZE) {
            this.ringBuffer.shift();
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
            return; // Skip recording during calibration
          }
          
          // If actively recording speech, accumulate in utterance buffer
          if (this.isSendingAudio) {
            this.utteranceBuffer.push(pcmData);
          }
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
   * Handle speech start event from echo-aware VAD worklet
   */
  private handleSpeechStart(): void {
    if (this.vadSpeaking) {
      return; // Already speaking
    }
    
    this.vadSpeaking = true;
    const timestamp = performance.now();
    console.log(`🎤 Echo-aware VAD: SPEECH DETECTED at ${timestamp.toFixed(0)}ms`);
    
    // Check if this is an interrupt (user speaking during TTS)
    const isInterrupt = this.isPlayingTTS;
    
    // Initialize utterance buffer WITH ring buffer (captures first word!)
    this.utteranceBuffer = [...this.ringBuffer];
    this.isSendingAudio = true;
    console.log(`🎤 Speech started - initialized with ${this.ringBuffer.length} ring buffer chunks (pre-roll)`);
    
    // Handle interrupt
    if (isInterrupt) {
      console.log('🎤 Interrupt detected - stopping TTS playback');
      
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
  
  /**
   * Handle speech end event from echo-aware VAD worklet
   */
  private handleSpeechEnd(): void {
    if (!this.vadSpeaking) {
      return; // Not speaking
    }
    
    this.vadSpeaking = false;
    console.log(`🔇 Echo-aware VAD: SPEECH ENDED`);
    
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
      console.log('🎵 Starting TTS playback session');
      this.isPlayingTTS = true;
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
        
        // Apply fade-in to first buffer if this is the start of playback
        // This prevents the crack/pop artifact from sudden audio start
        if (this.isFirstBuffer) {
          this.applyFadeIn(audioBuffer, this.FADE_IN_DURATION);
          this.isFirstBuffer = false;
        }
        
        this.audioQueue.push(audioBuffer);
        
        // Start smart queue manager if not already running
        if (!this.isPlaying && !this.queueManagerTimer) {
          console.log('🎵 Starting smart playback queue manager');
          this.isPlaying = true;
          this.startSmartQueueManager();
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
      
      // Fade-in will be applied by scheduleSingleBuffer when first buffer is scheduled
      
      console.log(`📦 Flushed ${this.pcmAccumulator.length} PCM chunks (${totalLength} samples) → ${audioBuffer.duration.toFixed(3)}s buffer added to queue (queue length: ${this.audioQueue.length + 1})`);
      
      // Clear accumulator
      this.pcmAccumulator = [];
      this.pcmAccumulatorTimer = null;
      
      // Add to playback queue
      this.audioQueue.push(audioBuffer);
      
      // Start smart queue manager if not already running
      if (!this.isPlaying && !this.queueManagerTimer) {
        console.log('🎵 Starting smart playback queue manager');
        this.isPlaying = true;
        this.startSmartQueueManager();
      } else {
        console.log(`⏳ Buffer queued (${this.audioQueue.length} in master queue, ${this.scheduledBuffers.length} scheduled)`);
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
      
      // Fade-in will be applied by scheduleSingleBuffer when first buffer is scheduled
      
      console.log(`📦 Final flush: ${this.pcmAccumulator.length} PCM chunks (${totalLength} samples) → ${audioBuffer.duration.toFixed(3)}s buffer`);
      
      // Clear accumulator
      this.pcmAccumulator = [];
      
      // Add to playback queue
      this.audioQueue.push(audioBuffer);
      
      // Start smart queue manager if not already running
      if (!this.isPlaying && !this.queueManagerTimer) {
        console.log('🎵 Starting smart playback queue manager');
        this.isPlaying = true;
        this.startSmartQueueManager();
      }
      
    } catch (error) {
      console.error('Error flushing remaining PCM:', error);
      this.pcmAccumulator = [];
    }
    
    // Clear carry byte on final flush
    this.pcmCarryByte = null;
  }

  /**
   * Apply fade-in to audio buffer to prevent crack/pop artifacts
   * @param audioBuffer - The audio buffer to fade in
   * @param fadeDuration - Duration of fade-in in seconds
   */
  private applyFadeIn(audioBuffer: AudioBuffer, fadeDuration: number): void {
    const sampleRate = audioBuffer.sampleRate;
    const fadeSamples = Math.floor(fadeDuration * sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    const fadeLength = Math.min(fadeSamples, channelData.length);
    
    // Apply linear fade-in envelope
    for (let i = 0; i < fadeLength; i++) {
      const fadeGain = i / fadeLength;
      channelData[i] *= fadeGain;
    }
    
    console.log(`🔇 Applied ${fadeDuration * 1000}ms fade-in to first buffer (${fadeLength} samples)`);
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

  /**
   * Start smart queue manager that maintains ~2 seconds of scheduled audio
   * Prevents audio engine overload and eliminates crackling
   */
  private startSmartQueueManager(): void {
    if (!this.playbackContext) {
      return;
    }

    // Clean up finished buffers
    const now = this.playbackContext.currentTime;
    this.scheduledBuffers = this.scheduledBuffers.filter(buffer => buffer.endTime > now);

    // Calculate how much audio is currently scheduled ahead
    let scheduledDuration = 0;
    if (this.scheduledBuffers.length > 0) {
      const lastBuffer = this.scheduledBuffers[this.scheduledBuffers.length - 1];
      scheduledDuration = Math.max(0, lastBuffer.endTime - now);
    }

    // Schedule more buffers if we have less than target duration
    while (scheduledDuration < this.TARGET_BUFFER_DURATION && this.audioQueue.length > 0) {
      const audioBuffer = this.audioQueue.shift()!;
      const scheduled = this.scheduleSingleBuffer(audioBuffer, now + scheduledDuration);
      if (scheduled) {
        scheduledDuration += audioBuffer.duration;
      } else {
        // Failed to schedule, put buffer back
        this.audioQueue.unshift(audioBuffer);
        break;
      }
    }

    // Check if we're done
    if (this.audioQueue.length === 0 && this.scheduledBuffers.length === 0) {
      console.log('🏁 All audio scheduled and played - stopping queue manager');
      this.isPlaying = false;
      this.queueManagerTimer = null;
      
      // Handle completion callback
      if (this.isPlayingTTS) {
        setTimeout(() => {
          if (this.audioQueue.length === 0 && this.scheduledBuffers.length === 0 && this.isPlayingTTS) {
            console.log('✅ TTS session complete - re-enabling VAD');
            this.isPlayingTTS = false;
            this.isFirstBuffer = true;
            
            if (this.onPlaybackComplete) {
              this.onPlaybackComplete();
            }
          }
        }, 200);
      } else if (this.onPlaybackComplete) {
        this.onPlaybackComplete();
      }
    } else {
      // Schedule next check
      this.queueManagerTimer = window.setTimeout(() => {
        this.startSmartQueueManager();
      }, this.QUEUE_CHECK_INTERVAL);
    }
  }

  /**
   * Schedule a single audio buffer for playback
   * Returns true if scheduled successfully, false otherwise
   */
  private scheduleSingleBuffer(audioBuffer: AudioBuffer, startTime: number): boolean {
    if (!this.playbackContext) {
      return false;
    }

    const currentTime = this.playbackContext.currentTime;
    
    // Ensure we don't schedule in the past
    if (startTime < currentTime) {
      startTime = currentTime + 0.01;
    }

    const endTime = startTime + audioBuffer.duration;
    
    try {
      // Apply fade-in to first buffer if needed
      if (this.isFirstBuffer) {
        this.applyFadeIn(audioBuffer, this.FADE_IN_DURATION);
        this.isFirstBuffer = false;
      }
      
      const source = this.playbackContext.createBufferSource();
      source.buffer = audioBuffer;
      
      const gainNode = this.playbackContext.createGain();
      gainNode.gain.value = 1.5;
      
      source.connect(gainNode);
      
      // Route TTS audio to both speakers (user hears) and AEC input (for echo cancellation)
      gainNode.connect(this.playbackContext.destination);
      if (this.ttsDestinationNode) {
        gainNode.connect(this.ttsDestinationNode);
      }
      
      source.start(startTime);
      
      // Track scheduled buffer
      this.scheduledBuffers.push({ source, endTime });
      
      // Store as current source for stopPlayback
      if (!this.currentSource) {
        this.currentSource = source;
        source.onended = () => {
          this.currentSource = null;
          // Clean up from scheduled buffers
          const index = this.scheduledBuffers.findIndex(b => b.source === source);
          if (index >= 0) {
            this.scheduledBuffers.splice(index, 1);
          }
        };
      }
      
      return true;
    } catch (error) {
      console.error('Error scheduling audio buffer:', error);
      return false;
    }
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
    
    // Route TTS audio to both speakers (user hears) and AEC input (for echo cancellation)
    gainNode.connect(this.playbackContext.destination);
    if (this.ttsDestinationNode) {
      gainNode.connect(this.ttsDestinationNode);
    }
    
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
              this.isFirstBuffer = true; // Reset for next TTS session
              
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
    
    // Stop queue manager
    if (this.queueManagerTimer) {
      clearTimeout(this.queueManagerTimer);
      this.queueManagerTimer = null;
    }
    
    // Stop all scheduled sources
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (error) {
        console.log('Source already stopped or error stopping:', error);
      }
      this.currentSource = null;
    }
    
    // Stop all scheduled buffers
    for (const buffer of this.scheduledBuffers) {
      try {
        buffer.source.stop();
      } catch (error) {
        // Ignore errors
      }
    }
    
    this.audioQueue = [];
    this.scheduledBuffers = [];
    this.isPlaying = false;
    
    if (this.isPlayingTTS) {
      this.isPlayingTTS = false;
    }
    
    this.playbackPlayhead = 0; // Reset playhead
    this.lastGainNode = null; // Clear gain node reference
    this.isFirstBuffer = true; // Reset for next TTS session
    
    // Reset VAD state when playback stops
    this.vadSpeaking = false;
    
    if (this.pcmAccumulatorTimer) {
      clearTimeout(this.pcmAccumulatorTimer);
      this.pcmAccumulatorTimer = null;
    }
    this.pcmAccumulator = [];
    this.pcmCarryByte = null;
    
    
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
        
      // Reset VAD state to ensure clean detection after TTS
      this.vadSpeaking = false;
      this.isFirstBuffer = true; // Reset for next TTS session
      
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
   * Simple pass-through to worklet
   */
  setVADThreshold(backendThreshold: number): void {
    // Send threshold to worklet
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'vad_threshold',
        threshold: backendThreshold
      });
    }
    
    console.log(`🎯 VAD threshold updated from backend calibration: ${backendThreshold.toFixed(6)}`);
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
    
    this.vadSpeaking = false;
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
    
    // Stop queue manager
    if (this.queueManagerTimer) {
      clearTimeout(this.queueManagerTimer);
      this.queueManagerTimer = null;
    }
    this.scheduledBuffers = [];
    
    // Disconnect AEC worklet
    if (this.aecNode) {
      this.aecNode.disconnect();
      this.aecNode.port.onmessage = null;
      this.aecNode = null;
    }
    
    // Disconnect TTS source node
    if (this.ttsSourceNode) {
      this.ttsSourceNode.disconnect();
      this.ttsSourceNode = null;
    }
    
    // Disconnect TTS destination node (no need to disconnect, just nullify)
    this.ttsDestinationNode = null;
    
    // Disconnect VAD worklet
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

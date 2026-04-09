/**
 * Production-Ready Audio Manager for Voice Calls
 * 
 * AudioWorklet-based implementation with ring buffer for zero first-word loss.
 * Outputs 16kHz WAV files optimized for Groq STT.
 */

// AEC processor is now a pre-compiled plain JS file at /aec-processor-worklet.js
// Fetched at runtime instead of imported as raw text (eliminates fragile TS stripping)

// Import WASM URL using Vite's ?url suffix - this gives us the resolved URL at build time
// @ts-ignore - ?url import might not be in type definitions
import wasmUrl from '@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm?url';

// Library JS file is copied to output root by vite-plugin-static-copy
// We'll fetch it at runtime to avoid build-time resolution issues
const JS_URL = '/webrtcaec3-0.3.0.js';

export class ProductionAudioManager {
  private recordingContext: AudioContext | null = null;
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
  private readonly CROSSFADE_DURATION = 0.008; // 8ms crossfade - matches normal TTS exactly
  private readonly FADE_IN_DURATION = 0.01; // 10ms fade-in for first buffer to prevent crack/pop
  private isFirstBuffer = true; // Track if this is the first buffer of TTS session (for fade-in)

  // AudioWorklet components
  private workletNode: AudioWorkletNode | null = null; // VAD worklet
  private aecNode: AudioWorkletNode | null = null; // AEC worklet
  private ttsDestinationNode: MediaStreamAudioDestinationNode | null = null; // Captures TTS for AEC
  private ttsSourceNode: MediaStreamAudioSourceNode | null = null; // TTS source in recording context
  private ringBuffer: Float32Array[] = [];
  private readonly RING_BUFFER_SIZE = 375; // ~1000ms pre-roll at 48kHz (128 samples/frame × 375 = 48000 samples ≈ 1000ms)
  private utteranceBuffer: Float32Array[] = [];
  private finalAudioBlob: Blob | null = null;

  // VAD state (managed by worklet)
  private vadSpeaking = false;
  private lastSpeechEndTime = 0; // Timestamp of last speech end (for cooldown)
  private readonly SPEECH_COOLDOWN_MS = 300; // Cooldown period after speech end before allowing new speech start

  // PCM accumulation for TTS playback
  private pcmAccumulator: Int16Array[] = [];
  private pcmAccumulatorTimer: number | null = null;
  private isFlushingPCM = false; // Guard flag to prevent concurrent flushes
  private readonly PCM_ACCUMULATION_TIME = 500; // Increased from 200ms to 500ms to reduce static noise
  private readonly PCM_MIN_SAMPLES = 48000; // ~3000ms at 16kHz - increased significantly for smoother playback and reduced crackling
  private pcmCarryByte: number | null = null; // Carry byte for odd-length buffers
  private keepAliveSource: AudioBufferSourceNode | null = null; // Keep AudioContext alive to prevent random suspensions
  private healthCheckInterval: number | null = null; // Periodic AudioContext health check for iOS
  private lastAudioDataTime = 0; // Timestamp of last audio_data from worklet (watchdog)
  
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

      // Force 48kHz: AEC3 library is designed for 48kHz and uses 480-sample (10ms) frames.
      // If the context defaults to the hardware rate (e.g. 192kHz), AEC frame sizes break
      // and VAD timing becomes wildly wrong (each 128-sample frame shrinks to <1ms).
      this.recordingContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
      console.log('🎵 ProductionAudioManager: Recording context created at', this.recordingContext.sampleRate, 'Hz (forced 48kHz for AEC compatibility)');
      
      // CRITICAL: Ensure AudioContext stays active to prevent crackling
      // Suspended contexts cause audio dropouts and crackling
      if (this.recordingContext.state === 'suspended') {
        console.log('🔧 AudioContext is suspended, resuming...');
        await this.recordingContext.resume();
      }

      // iOS: listen for state changes and immediately try to resume
      this.recordingContext.onstatechange = () => {
        const state = this.recordingContext?.state;
        console.warn(`⚠️ [iOS] AudioContext state changed to: ${state}`);
        if (state === 'suspended' && this.recordingContext) {
          this.recordingContext.resume().catch(() => {
            console.warn('❌ [iOS] Could not auto-resume AudioContext (may need user gesture)');
          });
        }
      };

      // CRITICAL: Keep AudioContext alive with continuous quiet tone
      // iOS can detect and suspend a gain=0 context; tiny non-zero gain keeps the session alive
      this.startKeepAliveTone();

      // Periodic health check: iOS may suspend AudioContext silently between turns
      this.startContextHealthCheck();

      // --- AEC + VAD Pipeline (with fallback to VAD-only if AEC fails) ---
      let aecEnabled = false;
      
      try {
        // Step 1: Fetch library JS + WASM + processor JS in parallel
        console.log('[AEC] Fetching webrtcaec3 library, WASM, and processor...');
        const [jsResponse, wasmResponse, processorResponse] = await Promise.all([
          fetch(JS_URL),
          fetch(wasmUrl),
          fetch('/aec-processor-worklet.js')
        ]);
        
        if (!jsResponse.ok) throw new Error(`JS library fetch failed: ${jsResponse.status}`);
        if (!wasmResponse.ok) throw new Error(`WASM fetch failed: ${wasmResponse.status}`);
        if (!processorResponse.ok) throw new Error(`AEC processor fetch failed: ${processorResponse.status}`);
        
        const [aecLibraryCode, wasmBuffer, processorCode] = await Promise.all([
          jsResponse.text(),
          wasmResponse.arrayBuffer(),
          processorResponse.text()
        ]);
        console.log(`[AEC] Assets loaded: lib=${aecLibraryCode.length} chars, wasm=${wasmBuffer.byteLength} bytes, processor=${processorCode.length} chars`);
        
        // Step 2: Combine library + processor into single worklet script (no TS stripping needed)
        let modifiedLibraryCode = aecLibraryCode
          .replace(/export\s*{\s*WebRtcAec3\s*};?/g, '')
          .replace(/export\s+default\s+WebRtcAec3;?/g, '');
        
        if (!modifiedLibraryCode.includes('var WebRtcAec3Wasm') && 
            !modifiedLibraryCode.includes('let WebRtcAec3Wasm') && 
            !modifiedLibraryCode.includes('const WebRtcAec3Wasm')) {
          modifiedLibraryCode = 'var WebRtcAec3Wasm;\n' + modifiedLibraryCode;
        }
        
        const finalWorkletScript = [
          '// --- webrtcaec3.js library ---',
          modifiedLibraryCode,
          '// --- AEC processor (pre-compiled plain JS) ---',
          processorCode
        ].join('\n');
        
        // Step 3: Load via Blob URL
        const blob = new Blob([finalWorkletScript], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        
        try {
          await this.recordingContext.audioWorklet.addModule(blobUrl);
          console.log('[AEC] ✅ AEC worklet module loaded');
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
        
        // Step 4: Create AEC node and initialize
        this.aecNode = new AudioWorkletNode(this.recordingContext, 'aec-processor', {
          numberOfInputs: 2,
          numberOfOutputs: 1
        });
        
        const aecInitPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('AEC init timeout (10s)')), 10000);
          this.aecNode!.port.onmessage = (event) => {
            if (event.data.type === 'init-done') { clearTimeout(timeout); resolve(); }
            else if (event.data.type === 'init-error') { clearTimeout(timeout); reject(new Error(event.data.error)); }
          };
        });
        
        this.aecNode.port.postMessage({
          type: 'init',
          sampleRate: this.recordingContext.sampleRate,
          wasm: wasmBuffer
        }, [wasmBuffer]);
        
        await aecInitPromise;
        console.log('[AEC] ✅ AEC initialized successfully');
        
        // Step 5: Create TTS routing nodes for AEC reference signal
        this.ttsDestinationNode = this.recordingContext.createMediaStreamDestination();
        this.ttsSourceNode = this.recordingContext.createMediaStreamSource(this.ttsDestinationNode.stream);
        
        aecEnabled = true;
      } catch (aecError: any) {
        console.warn(`[AEC] ⚠️ AEC setup failed, falling back to VAD-only mode: ${aecError.message}`);
        console.warn('[AEC] Voice will work but echo cancellation will rely on browser defaults only.');
        // Clean up partial AEC state
        this.aecNode = null;
        this.ttsDestinationNode = null;
        this.ttsSourceNode = null;
        aecEnabled = false;
      }
      
      // --- Load VAD worklet (required for both AEC and fallback paths) ---
      await this.recordingContext.audioWorklet.addModule('/audio-processor.js');
      console.log('✅ VAD worklet loaded');
      
      this.workletNode = new AudioWorkletNode(this.recordingContext, 'audio-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1
      });
      
      // --- Wire up audio graph ---
      const micSource = this.recordingContext.createMediaStreamSource(this.mediaStream);
      
      if (aecEnabled && this.aecNode && this.ttsSourceNode) {
        // Full AEC pipeline: mic → AEC(input0), TTS → AEC(input1), AEC → VAD
        micSource.connect(this.aecNode, 0, 0);
        this.ttsSourceNode.connect(this.aecNode, 0, 1);
        this.aecNode.connect(this.workletNode);
        console.log('✅ Audio chain: mic → AEC → VAD (echo cancellation active)');
      } else {
        // Fallback: mic → VAD directly (relies on browser echo cancellation)
        micSource.connect(this.workletNode);
        console.log('✅ Audio chain: mic → VAD (fallback mode, no AEC)');
      }

      // --- Handle VAD worklet messages ---
      this.workletNode.port.onmessage = (event) => {
        const message = event.data;
        
        if (message.type === 'speech_start') {
          this.handleSpeechStart();
        } else if (message.type === 'speech_end') {
          this.handleSpeechEnd();
        } else if (message.type === 'audio_data') {
          const pcmData: Float32Array = message.data;

          // Update watchdog timestamp — worklet is alive
          this.lastAudioDataTime = performance.now();

          // Maintain ring buffer (pre-roll for capturing first word)
          this.ringBuffer.push(pcmData);
          if (this.ringBuffer.length > this.RING_BUFFER_SIZE) {
            this.ringBuffer.shift();
          }
          
          // During calibration, send audio chunks for backend threshold calculation
          if (this.isCalibrating && this.onCalibrationChunk) {
            const int16Data = new Int16Array(pcmData.length);
            for (let i = 0; i < pcmData.length; i++) {
              const sample = Math.max(-1, Math.min(1, pcmData[i]));
              int16Data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            }
            this.onCalibrationChunk(int16Data.buffer);
            return;
          }
          
          // Accumulate audio during active speech
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
   * Handle speech start event from VAD worklet.
   *
   * Industry-standard barge-in:
   *  - If TTS is playing → immediate interrupt (zero cooldown)
   *  - Otherwise → apply a short cooldown to prevent echo-triggered re-fires
   */
  private handleSpeechStart(): void {
    if (this.vadSpeaking) return; // Already in speech

    const now = performance.now();
    const isInterrupt = this.isPlayingTTS;

    // Cooldown gate — skip entirely for interrupts (barge-in must be instant)
    if (!isInterrupt && this.lastSpeechEndTime > 0) {
      const elapsed = now - this.lastSpeechEndTime;
      if (elapsed < this.SPEECH_COOLDOWN_MS) {
        return; // Too soon after last utterance ended — likely echo
      }
    }

    this.vadSpeaking = true;
    console.log(`🎤 VAD: SPEECH START (interrupt: ${isInterrupt})`);

    // ── Barge-in path ──
    if (isInterrupt) {
      // 1. Kill TTS playback immediately (stops Web Audio nodes)
      this.stopPlayback();

      // 2. Delay AEC tts_stopped by 350ms — hardware speaker has buffered audio
      //    that physically keeps playing for 100-300ms after JS stopPlayback().
      //    Keeping AEC active during this window prevents residual TTS from leaking
      //    into the utterance buffer uncancelled.
      const aecNodeRef = this.aecNode;
      if (aecNodeRef) {
        setTimeout(() => {
          aecNodeRef.port.postMessage({ type: 'tts_stopped' });
        }, 350);
      }

      // 3. Clear ring buffer — it's full of TTS echo, not user speech.
      this.ringBuffer = [];

      // 4. Reset cooldown for rapid re-interrupt
      this.lastSpeechEndTime = 0;

      // 5. Send interrupt to backend
      if (this.onInterrupt) {
        this.onInterrupt();
      }
    }

    // Initialize utterance buffer with ring buffer pre-roll (captures first word)
    this.utteranceBuffer = [...this.ringBuffer];
    this.isSendingAudio = true;

    // Notify backend: user started speaking
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
    this.lastSpeechEndTime = performance.now(); // Record timestamp for cooldown
    console.log(`🔇 Echo-aware VAD: SPEECH ENDED (cooldown started)`);
    
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
   * Convert Float32 PCM to 16kHz WAV with linear-interpolation downsampling.
   * Speech content is concentrated below 4kHz, well within the 8kHz Nyquist of
   * 16kHz output, so simple linear interpolation gives Whisper clean input.
   */
  private pcmToWav16k(pcm48k: Float32Array, sampleRate: number): Blob {
    const targetRate = 16000;
    const ratio = sampleRate / targetRate; // 3.0 for 48k→16k
    const outputLength = Math.floor(pcm48k.length / ratio);
    const pcm16k = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const srcFloor = Math.floor(srcIndex);
      const srcCeil = Math.min(srcFloor + 1, pcm48k.length - 1);
      const frac = srcIndex - srcFloor;
      pcm16k[i] = pcm48k[srcFloor] * (1 - frac) + pcm48k[srcCeil] * frac;
    }

    console.log(`🔄 Downsampled ${pcm48k.length} @ ${sampleRate}Hz → ${pcm16k.length} @ ${targetRate}Hz`);

    const int16Data = new Int16Array(pcm16k.length);
    for (let i = 0; i < pcm16k.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm16k[i]));
      int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    const wavHeader = this.createWavHeader(int16Data.length * 2, targetRate, 1);
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
    if (!this.recordingContext) {
      console.error('Recording context not initialized');
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
      
      // Notify AEC that TTS is starting so it activates echo cancellation
      if (this.aecNode) {
        this.aecNode.port.postMessage({ type: 'tts_started' });
      }
      // Notify VAD to raise threshold during TTS (second layer of echo protection)
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'tts_playing', playing: true });
      }
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
        const audioBuffer = await this.recordingContext.decodeAudioData(audioData.slice(0));
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
    if (!this.recordingContext) return;
    
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
        this.flushPCMAccumulator(false);
      } else {
        // Set timer to flush accumulator after accumulation time
        this.pcmAccumulatorTimer = window.setTimeout(() => {
          this.flushPCMAccumulator(true); // Force flush on timeout
        }, this.PCM_ACCUMULATION_TIME);
      }
      
    } catch (error) {
      console.error('Error accumulating PCM chunk:', error);
      // Reset carry byte on error
      this.pcmCarryByte = null;
    }
  }

  private flushPCMAccumulator(force: boolean = false): void {
    // Guard: prevent concurrent flushes
    if (this.isFlushingPCM) {
      console.log('⏸️ Flush already in progress, skipping duplicate flush');
      return;
    }
    
    if (this.pcmAccumulator.length === 0 || !this.recordingContext) {
      // Clear timer if accumulator is empty
      if (this.pcmAccumulatorTimer) {
        clearTimeout(this.pcmAccumulatorTimer);
        this.pcmAccumulatorTimer = null;
      }
      return;
    }
    
    // Set guard flag
    this.isFlushingPCM = true;
    
    try {
      // Clear timer immediately to prevent duplicate flushes
      if (this.pcmAccumulatorTimer) {
        clearTimeout(this.pcmAccumulatorTimer);
        this.pcmAccumulatorTimer = null;
      }
      
      // Calculate total samples available
      const totalLength = this.pcmAccumulator.reduce((sum, chunk) => sum + chunk.length, 0);
      
      // Only flush if we have minimum samples (unless forced)
      if (!force && totalLength < this.PCM_MIN_SAMPLES) {
        // Don't flush yet, wait for more samples
        this.isFlushingPCM = false; // Release guard
        return;
      }
      
      // CRITICAL: Use splice to take only what we need, preserving order
      // Take at least PCM_MIN_SAMPLES, or a multiple of it for smooth playback
      // This matches the normal TTS behavior and ensures correct ordering
      const takeSamples = force 
        ? totalLength 
        : Math.max(this.PCM_MIN_SAMPLES, Math.floor(totalLength / this.PCM_MIN_SAMPLES) * this.PCM_MIN_SAMPLES);
      
      // Extract chunks in order until we have enough samples
      const chunksToFlush: Int16Array[] = [];
      let samplesTaken = 0;
      
      while (samplesTaken < takeSamples && this.pcmAccumulator.length > 0) {
        const chunk = this.pcmAccumulator.shift()!; // Remove from front (FIFO - maintains order)
        chunksToFlush.push(chunk);
        samplesTaken += chunk.length;
      }
      
      if (chunksToFlush.length === 0) {
        this.isFlushingPCM = false; // Release guard
        return;
      }
      
      // Combine chunks in order
      const combinedSamples = new Int16Array(samplesTaken);
      let offset = 0;
      for (const chunk of chunksToFlush) {
        combinedSamples.set(chunk, offset);
        offset += chunk.length;
      }
      
      // CRITICAL: Create buffer at 16kHz and let browser handle resampling automatically
      // Browser's native resampling is MUCH better than manual resampling - eliminates crackling!
      // Normal TTS uses this approach and sounds perfect
      const floatSamples = new Float32Array(combinedSamples.length);
      for (let i = 0; i < combinedSamples.length; i++) {
        floatSamples[i] = combinedSamples[i] / 32768.0;
      }
      
      // Create buffer at 16kHz - browser will automatically resample to AudioContext sample rate
      const audioBuffer = this.recordingContext.createBuffer(1, floatSamples.length, 16000);
      const channelData = audioBuffer.getChannelData(0);
      channelData.set(floatSamples);
      
      // Schedule buffer immediately - no concatenation, just like normal TTS
      // Browser-native resampling handles everything smoothly
      console.log(`📦 Flushed ${chunksToFlush.length} PCM chunks (${samplesTaken} samples) → ${audioBuffer.duration.toFixed(3)}s buffer (${this.pcmAccumulator.length} chunks remaining)`);
      
      // Add directly to queue - no concatenation needed
      this.audioQueue.push(audioBuffer);
      
      // Start smart queue manager if not already running
      if (!this.isPlaying && !this.queueManagerTimer) {
        console.log('🎵 Starting smart playback queue manager');
        this.isPlaying = true;
        this.startSmartQueueManager();
      } else {
        console.log(`⏳ Buffer queued (${this.audioQueue.length} in master queue, ${this.scheduledBuffers.length} scheduled)`);
      }
      
      // If there are remaining chunks and we have enough samples, flush again immediately
      // This ensures continuous playback without gaps
      const remainingSamples = this.pcmAccumulator.reduce((sum, chunk) => sum + chunk.length, 0);
      if (remainingSamples >= this.PCM_MIN_SAMPLES) {
        // Release guard and flush again (recursive, but guarded)
        this.isFlushingPCM = false;
        this.flushPCMAccumulator(false);
        return;
      }
      
    } catch (error) {
      console.error('Error flushing PCM accumulator:', error);
      this.pcmAccumulator = [];
      this.pcmCarryByte = null; // Reset carry byte on error
    } finally {
      // Always release guard flag
      this.isFlushingPCM = false;
    }
  }

  flushRemainingPCM(): void {
    console.log('🔚 TTS sentence complete - flushing remaining PCM accumulator');
    
    // Clear timer
    if (this.pcmAccumulatorTimer) {
      clearTimeout(this.pcmAccumulatorTimer);
      this.pcmAccumulatorTimer = null;
    }
    
    // Wait for any in-progress flush to complete
    if (this.isFlushingPCM) {
      console.log('⏳ Waiting for in-progress flush to complete before final flush');
      // Wait a bit and retry (simple approach - could use Promise if needed)
      setTimeout(() => this.flushRemainingPCM(), 50);
      return;
    }
    
    // Force flush even if below minimum samples
    const totalLength = this.pcmAccumulator.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalLength === 0 || !this.recordingContext) {
      this.pcmCarryByte = null;
      return;
    }
    
    // Set guard flag
    this.isFlushingPCM = true;
    
    try {
      // CRITICAL: Extract chunks in order using shift (FIFO - maintains order)
      // This matches normal TTS behavior and ensures correct ordering
      const chunksToFlush: Int16Array[] = [];
      while (this.pcmAccumulator.length > 0) {
        chunksToFlush.push(this.pcmAccumulator.shift()!); // Remove from front
      }
      
      // Combine all accumulated chunks (force flush regardless of minimum)
      const combinedSamples = new Int16Array(totalLength);
      
      let offset = 0;
      for (const chunk of chunksToFlush) {
        combinedSamples.set(chunk, offset);
        offset += chunk.length;
      }
      
      // CRITICAL: Create buffer at 16kHz and let browser handle resampling automatically
      // Browser's native resampling is MUCH better than manual resampling - eliminates crackling!
      // Normal TTS uses this approach and sounds perfect
      const floatSamples = new Float32Array(combinedSamples.length);
      for (let i = 0; i < combinedSamples.length; i++) {
        floatSamples[i] = combinedSamples[i] / 32768.0;
      }
      
      // Create buffer at 16kHz - browser will automatically resample to AudioContext sample rate
      const audioBuffer = this.recordingContext.createBuffer(1, floatSamples.length, 16000);
      const channelData = audioBuffer.getChannelData(0);
      channelData.set(floatSamples);
      
      // Schedule buffer immediately - no concatenation, just like normal TTS
      console.log(`📦 Final flush: ${chunksToFlush.length} PCM chunks (${totalLength} samples) → ${audioBuffer.duration.toFixed(3)}s buffer`);
      
      // Add directly to queue - no concatenation needed
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
      console.error('Error flushing remaining PCM accumulator:', error);
      this.pcmAccumulator = [];
      this.pcmCarryByte = null;
    } finally {
      // Always release guard flag
      this.isFlushingPCM = false;
      // Clear carry byte on final flush
      this.pcmCarryByte = null;
    }
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
    if (!this.recordingContext) {
      return;
    }

    // Clean up finished buffers
    const now = this.recordingContext.currentTime;
    this.scheduledBuffers = this.scheduledBuffers.filter(buffer => buffer.endTime > now);

    // Calculate how much audio is currently scheduled ahead
    let scheduledDuration = 0;
    if (this.scheduledBuffers.length > 0) {
      const lastBuffer = this.scheduledBuffers[this.scheduledBuffers.length - 1];
      scheduledDuration = Math.max(0, lastBuffer.endTime - now);
    }

    // Schedule more buffers if we have less than target duration
    // Use 8ms crossfade like normal TTS for seamless playback
    let nextStartTime = now;
    if (this.scheduledBuffers.length > 0) {
      const lastBuffer = this.scheduledBuffers[this.scheduledBuffers.length - 1];
      // Start next buffer with 8ms overlap (matches normal TTS)
      nextStartTime = Math.max(now, lastBuffer.endTime - this.CROSSFADE_DURATION);
    }
    
    while (scheduledDuration < this.TARGET_BUFFER_DURATION && this.audioQueue.length > 0) {
      const audioBuffer = this.audioQueue.shift()!;
      const scheduled = this.scheduleSingleBuffer(audioBuffer, nextStartTime);
      if (scheduled) {
        // Update playhead: end time minus crossfade (matches normal TTS)
        nextStartTime = nextStartTime + audioBuffer.duration - this.CROSSFADE_DURATION;
        scheduledDuration = Math.max(0, nextStartTime - now);
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
      // Use a generous delay (1.5s) to allow more PCM chunks to arrive from the backend
      // between multi-chunk TTS requests. The VoiceCallButton gates tts_playback_finished
      // behind tts_stream_end, so even if this fires early it won't cause premature transition.
      // But we still want to avoid clearing isPlayingTTS too early (which would notify AEC/VAD
      // that TTS stopped, causing echo issues when the next chunk arrives).
      if (this.isPlayingTTS) {
        setTimeout(() => {
          if (this.audioQueue.length === 0 && this.scheduledBuffers.length === 0 && this.isPlayingTTS) {
            console.log('✅ TTS queue empty for 1.5s - firing playback complete callback');
            // Do NOT clear isPlayingTTS here — let completeTTSSession handle it
            // when the backend confirms all chunks are done via tts_stream_end.
            // This keeps AEC/VAD in TTS-aware mode between multi-chunk gaps.
            
            if (this.onPlaybackComplete) {
              this.onPlaybackComplete();
            }
          }
        }, 1500);
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
    if (!this.recordingContext) {
      return false;
    }
    
    const currentTime = this.recordingContext.currentTime;
    
    // Ensure we don't schedule in the past
    if (startTime < currentTime) {
      startTime = currentTime + 0.01;
    }

    let endTime = startTime + audioBuffer.duration;
    
    try {
      // Don't modify buffer data - let browser handle everything (matches normal TTS)
      // Normal TTS doesn't modify buffer data, just schedules with crossfades
      
      const source = this.recordingContext.createBufferSource();
      source.buffer = audioBuffer;
      
      const gainNode = this.recordingContext.createGain();
      
      // Use exact same crossfade logic as normal TTS (8ms crossfade)
      if (this.lastGainNode && this.scheduledBuffers.length > 0) {
        const lastBuffer = this.scheduledBuffers[this.scheduledBuffers.length - 1];
        const prevEnd = lastBuffer.endTime;
        
        // Start new buffer with 8ms overlap (matches normal TTS)
        startTime = Math.max(currentTime, prevEnd - this.CROSSFADE_DURATION);
        endTime = startTime + audioBuffer.duration;
        
        // Fade out previous buffer during crossfade (matches normal TTS exactly)
        const downStart = Math.max(currentTime, prevEnd - this.CROSSFADE_DURATION);
        try {
          this.lastGainNode.gain.setValueAtTime(1, downStart);
          this.lastGainNode.gain.linearRampToValueAtTime(0, prevEnd);
        } catch (e) {
          // Ignore scheduling errors
        }
        
        // Fade in new buffer during crossfade (matches normal TTS exactly)
        try {
          gainNode.gain.setValueAtTime(0, startTime);
          gainNode.gain.linearRampToValueAtTime(1, startTime + this.CROSSFADE_DURATION);
        } catch (e) {
          gainNode.gain.value = 1;
        }
      } else {
        // First buffer - set gain to 1 (matches normal TTS)
        try {
          gainNode.gain.setValueAtTime(1, startTime);
        } catch (e) {
          gainNode.gain.value = 1;
        }
      }
      
      source.connect(gainNode);

      // Route TTS audio to both speakers (user hears) and AEC input (for echo cancellation)
      gainNode.connect(this.recordingContext.destination);
      if (this.ttsDestinationNode) {
        gainNode.connect(this.ttsDestinationNode);
      }
      
      source.start(startTime);
      
      // Store gain node for next buffer's fade-out
      this.lastGainNode = gainNode;
      
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

    if (!this.recordingContext) {
      return;
    }

    // CRITICAL: Set isPlaying = true SYNCHRONOUSLY
    this.isPlaying = true;
    this.manuallyStoppedPlayback = false;
    
    const audioBuffer = this.audioQueue.shift()!;
    const currentTime = this.recordingContext.currentTime;
    
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
    
    if (!this.recordingContext) {
      return;
    }
    
    this.currentSource = this.recordingContext.createBufferSource();
    this.currentSource.buffer = audioBuffer;
    
    const gainNode = this.recordingContext.createGain();
    
    // Apply crossfade if there's a previous buffer
    if (this.lastGainNode) {
      // Simple linear crossfade - more reliable
      try {
        const fadeStart = Math.max(currentTime, startTime - this.CROSSFADE_DURATION);
        this.lastGainNode.gain.setValueAtTime(1.0, fadeStart);
        this.lastGainNode.gain.linearRampToValueAtTime(0, startTime);
      } catch (e) {
        // Ignore scheduling errors
      }
      
      // Fade in new buffer from start
      // Simple linear ramp - more reliable
      try {
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(1.0, startTime + this.CROSSFADE_DURATION);
      } catch (e) {
        gainNode.gain.value = 1.0;
      }
    } else {
      // First buffer - no crossfade needed
      gainNode.gain.value = 1.0;
    }
    
    this.currentSource.connect(gainNode);
    
    // Route TTS audio to both speakers (user hears) and AEC input (for echo cancellation)
    gainNode.connect(this.recordingContext.destination);
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
        
        // Only fire completion if TTS session is active.
        // Do NOT clear isPlayingTTS here — let completeTTSSession handle it
        // when the backend confirms all chunks are done via tts_stream_end.
        // This keeps AEC/VAD in TTS-aware mode between multi-chunk gaps.
        if (this.isPlayingTTS) {
          setTimeout(() => {
            if (this.audioQueue.length === 0 && !this.isPlaying && this.isPlayingTTS) {
              console.log('✅ TTS queue empty for 1.5s (playNextInQueue path) - firing completion callback');
              
              if (this.onPlaybackComplete) {
                this.onPlaybackComplete();
              }
            }
          }, 1500); // 1.5s delay to bridge multi-chunk TTS gaps
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
    
    // CRITICAL: Notify AEC and VAD that TTS stopped BEFORE stopping playback
    // This allows AEC to adapt and VAD to lower threshold immediately
    if (this.aecNode) {
      this.aecNode.port.postMessage({ type: 'tts_stopped' });
    }
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'tts_playing', playing: false });
    }
    console.log('🔔 Notified AEC+VAD that TTS stopped');
    
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
      // Still always clear TTS mode so VAD doesn't stay stuck at 3x thresholds
      this.forceClearTTSMode();
      return;
    }

    // Always reset VAD TTS mode — even if isPlayingTTS is already false
    // (race conditions on iOS can leave the flag stale between turns).
    this.forceClearTTSMode();

    if (this.isPlayingTTS) {
      console.log('✅ Marking TTS session as complete, re-enabling VAD');
      this.isPlayingTTS = false;
      this.vadSpeaking = false;
      this.isFirstBuffer = true;

      if (!this.isPlaying && this.onPlaybackComplete) {
        console.log('🔔 Notifying backend: TTS playback complete');
        this.onPlaybackComplete();
      } else if (this.isPlaying) {
        console.log('⏳ Audio still playing, will notify when queue empties');
      }
    } else {
      console.log('ℹ️  No active TTS session to complete (flags already cleared)');
    }
  }

  /**
   * Unconditionally tell AEC and VAD that TTS is done.
   * Called both from completeTTSSession AND proactively when tts_stream_end arrives,
   * so the VAD drops its 3x threshold as soon as possible — improving STT onset capture.
   */
  public forceClearTTSMode(): void {
    if (this.aecNode) {
      this.aecNode.port.postMessage({ type: 'tts_stopped' });
    }
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'tts_playing', playing: false });
    }
    console.log('🔇 [forceClearTTSMode] AEC + VAD notified: TTS done');
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
   * Apply multiplier to prevent over-sensitivity and ensure minimum threshold
   */
  setVADThreshold(backendThreshold: number): void {
    // Apply multiplier to backend threshold to prevent over-sensitivity
    // Backend calibration can be too sensitive, especially in quiet environments
    // BUT: Don't make it too high or VAD won't detect speech at all
    // Reduced multiplier to allow better detection, especially after AEC processing
    const THRESHOLD_MULTIPLIER = 1.2; // Increase threshold by 1.2x (reduced from 1.5x to allow detection)
    const MIN_THRESHOLD = 0.0008; // Minimum threshold (reduced from 0.001 to allow detection)
    
    const adjustedThreshold = Math.max(
      backendThreshold * THRESHOLD_MULTIPLIER,
      MIN_THRESHOLD
    );
    
    // Send adjusted threshold to worklet
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'vad_threshold',
        threshold: adjustedThreshold
      });
    }
    
    console.log(`🎯 VAD threshold updated: backend=${backendThreshold.toFixed(6)}, adjusted=${adjustedThreshold.toFixed(6)} (${THRESHOLD_MULTIPLIER}x multiplier, min=${MIN_THRESHOLD})`);
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

  /**
   * Start a continuous silent tone to keep AudioContext alive
   * Prevents random suspensions that cause crackling
   */
  private startKeepAliveTone(): void {
    if (!this.recordingContext) return;
    
    // Stop existing keep-alive if any
    this.stopKeepAliveTone();
    
    // Create a very long silent buffer (10 seconds)
    const keepAliveBuffer = this.recordingContext.createBuffer(1, this.recordingContext.sampleRate * 10, this.recordingContext.sampleRate);
    this.keepAliveSource = this.recordingContext.createBufferSource();
    this.keepAliveSource.buffer = keepAliveBuffer;
    
    // Use a tiny non-zero gain — iOS detects true silence and may suspend the context.
    // -120 dB equivalent is completely inaudible but keeps the audio session active.
    const gainNode = this.recordingContext.createGain();
    gainNode.gain.value = 0.0001; // ~-80 dB — inaudible, but non-zero for iOS
    this.keepAliveSource.connect(gainNode);
    gainNode.connect(this.recordingContext.destination);

    // Start and loop
    this.keepAliveSource.loop = true;
    this.keepAliveSource.start(0);

    console.log('🔇 Started keep-alive tone (tiny non-zero gain for iOS audio session)');
  }
  
  /**
   * Periodic health check for iOS AudioContext suspension.
   * iOS can suspend the context silently between TTS sessions without firing onstatechange.
   * Runs every 500 ms; resumes the context if suspended.
   */
  private startContextHealthCheck(): void {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = window.setInterval(() => {
      if (!this.recordingContext) return;
      if (this.recordingContext.state === 'suspended') {
        console.warn('⚠️ [HealthCheck] AudioContext suspended — resuming...');
        this.recordingContext.resume().catch(() => {});
      }
      // Watchdog: if worklet has been silent for >8 s while we expect audio, log a warning
      if (this.lastAudioDataTime > 0 && !this.vadSpeaking) {
        const elapsed = performance.now() - this.lastAudioDataTime;
        if (elapsed > 8000) {
          console.warn(`⚠️ [HealthCheck] No audio_data from VAD worklet for ${(elapsed / 1000).toFixed(1)}s — AudioContext may be stuck`);
          // Attempt resume in case iOS suspended without firing onstatechange
          if (this.recordingContext.state !== 'closed') {
            this.recordingContext.resume().catch(() => {});
          }
          // Reset timer so we don't spam the log
          this.lastAudioDataTime = performance.now();
        }
      }
    }, 500);
  }

  private stopContextHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private stopKeepAliveTone(): void {
    if (this.keepAliveSource) {
      try {
        this.keepAliveSource.stop();
      } catch (e) {
        // Ignore if already stopped
      }
      this.keepAliveSource = null;
    }
  }

  cleanup(): void {
    this.stopContextHealthCheck();
    this.stopKeepAliveTone();
    if (this.recordingContext) {
      this.recordingContext.onstatechange = null;
    }
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
    
    // Stop keep-alive tone
    this.stopKeepAliveTone();
    
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

    this.onPlaybackComplete = null;
    
    console.log('Audio manager cleaned up');
  }
}


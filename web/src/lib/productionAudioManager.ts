/**
 * Production-Ready Audio Manager for Voice Calls
 * 
 * AudioWorklet-based implementation with ring buffer for zero first-word loss.
 * Outputs 16kHz WAV files optimized for Groq STT.
 */

// Import processor code as raw text (will be combined with library code)
// @ts-ignore - ?raw import might not be in type definitions
import aecProcessorCode from './aec-processor.ts?raw';

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
  private readonly RING_BUFFER_SIZE = 350; // ~933ms pre-roll at 48kHz (128 samples per chunk @ 20ms)
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
  private pendingBuffers: AudioBuffer[] = []; // Accumulate buffers before concatenating for seamless playback
  private keepAliveSource: AudioBufferSourceNode | null = null; // Keep AudioContext alive to prevent random suspensions
  
  /**
   * Resample audio from 16kHz to the recording context's sample rate using linear interpolation
   * CRITICAL: Use actual AudioContext sample rate, not hardcoded 48kHz!
   * @param input16k Int16Array of 16kHz PCM samples
   * @returns Float32Array of samples at recording context sample rate (normalized to [-1, 1])
   */
  private resample16kToTargetRate(input16k: Int16Array): Float32Array {
    if (!this.recordingContext) {
      throw new Error('Recording context not available for resampling');
    }
    
    const inputSampleRate = 16000;
    const outputSampleRate = this.recordingContext.sampleRate; // Use ACTUAL sample rate, not hardcoded!
    const ratio = outputSampleRate / inputSampleRate;
    
    const inputLength = input16k.length;
    const outputLength = Math.ceil(inputLength * ratio);
    const output = new Float32Array(outputLength);
    
    // Normalize input to float32
    const inputFloat = new Float32Array(inputLength);
    for (let i = 0; i < inputLength; i++) {
      inputFloat[i] = input16k[i] / 32768.0;
    }
    
    // Linear interpolation with correct ratio
    for (let i = 0; i < outputLength; i++) {
      const inputPos = i / ratio;
      const inputIndex = Math.floor(inputPos);
      const fraction = inputPos - inputIndex;
      
      if (inputIndex < inputLength - 1) {
        // Linear interpolation between two samples
        output[i] = inputFloat[inputIndex] * (1 - fraction) + inputFloat[inputIndex + 1] * fraction;
      } else if (inputIndex < inputLength) {
        // Last sample
        output[i] = inputFloat[inputIndex];
      } else {
        // Beyond end - use last sample
        output[i] = inputFloat[inputLength - 1];
      }
    }
    
    return output;
  }


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

      // Create recording context at browser's native sample rate (may vary by browser/device)
      // We'll resample TTS audio from 16kHz to the actual context sample rate
      this.recordingContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      console.log('🎵 ProductionAudioManager: Recording context created at', this.recordingContext.sampleRate, 'Hz (will resample TTS from 16kHz to this rate)');
      
      // CRITICAL: Ensure AudioContext stays active to prevent crackling
      // Suspended contexts cause audio dropouts and crackling
      if (this.recordingContext.state === 'suspended') {
        console.log('🔧 AudioContext is suspended, resuming...');
        await this.recordingContext.resume();
      }
      
      // CRITICAL: Keep AudioContext alive with continuous silent tone
      // Random suspensions cause crackling - this prevents them
      this.startKeepAliveTone();

      // Fetch library JS file from simple URL (copied to output root by vite-plugin-static-copy)
      // This bypasses Node module resolution and avoids build-time errors
      console.log('Fetching webrtcaec3 library JS file...');
      const jsResponse = await fetch(JS_URL);
      if (!jsResponse.ok) {
        throw new Error(`Failed to fetch JS library: ${jsResponse.status} ${jsResponse.statusText}`);
      }
      const aecLibraryCode = await jsResponse.text();
      console.log('✅ JS library code fetched, size:', aecLibraryCode.length, 'characters');
      
      // Pre-fetch WASM buffer in main thread using Vite-resolved URL
      // This prevents network requests from within the Blob worklet
      console.log('Pre-fetching WASM module from:', wasmUrl);
      const wasmResponse = await fetch(wasmUrl);
      if (!wasmResponse.ok) {
        throw new Error(`Failed to fetch WASM file: ${wasmResponse.status} ${wasmResponse.statusText}`);
      }
      const wasmBuffer = await wasmResponse.arrayBuffer();
      console.log('✅ WASM buffer pre-fetched, size:', wasmBuffer.byteLength, 'bytes');
      
      // Dynamically construct the worklet script as a single ES module
      // This bypasses all module-loading restrictions by creating our own mega-module
      console.log('Constructing AEC worklet module from library and processor code...');
      
      // Remove export statements from library code so we can use it directly
      // The library exports WebRtcAec3, we need to make it available in our scope
      // Also patch the library to declare WebRtcAec3Wasm variable (prevents ReferenceError)
      // No need to patch WASM URLs since we're passing the buffer directly to the factory
      let modifiedLibraryCode = aecLibraryCode
        .replace(/export\s*{\s*WebRtcAec3\s*};?/g, '') // Remove export statement
        .replace(/export\s+default\s+WebRtcAec3;?/g, ''); // Remove default export if present
      
      // Patch: Add WebRtcAec3Wasm declaration at the beginning if not already present
      // This prevents "assignment to undeclared variable" errors in module context
      if (!modifiedLibraryCode.includes('var WebRtcAec3Wasm') && 
          !modifiedLibraryCode.includes('let WebRtcAec3Wasm') && 
          !modifiedLibraryCode.includes('const WebRtcAec3Wasm')) {
        modifiedLibraryCode = 'var WebRtcAec3Wasm;\n' + modifiedLibraryCode;
        console.log('✅ Patched library code: added WebRtcAec3Wasm declaration');
      }
      
      // Remove any import/export statements from processor code
      // Also strip TypeScript syntax since this will be executed as plain JavaScript
      // The processor code should only contain the class definition and registration
      
      // First, remove multi-line declare statement (must be done on full text, not line by line)
      let modifiedProcessorCode = aecProcessorCode
        // Remove multi-line WebRtcAec3 type declaration (spans multiple lines)
        .replace(/\/\/\s*Declare WebRtcAec3[\s\S]*?declare\s+const\s+WebRtcAec3\s*:[\s\S]*?\}>;\s*/g, '')
        // Remove standalone declare statements
        .replace(/^\s*declare\s+const\s+WebRtcAec3[\s\S]*?\}>;\s*$/gm, '')
        // Remove import/export statements
        .replace(/^\s*import\s+.*$/gm, '')
        .replace(/^\s*export\s+.*$/gm, '');
      
      // Now process line by line to avoid breaking comments
      const lines = modifiedProcessorCode.split('\n');
      const processedLines = lines.map((line: string) => {
        // Skip comment lines - don't modify them (single-line // comments, multi-line /* */ comments)
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
          return line;
        }
        
        // Process non-comment lines
        let processedLine = line;
        
        // Remove type annotations from arrow function parameters
        processedLine = processedLine.replace(/\((\w+)\s*:\s*[^)]+\)\s*=>/g, '($1) =>');
        
        // Remove type annotations from regular function parameters
        processedLine = processedLine.replace(/\(([^)]+)\)(?!\s*=>)/g, (_match: string, params: string) => {
          const cleanedParams = params.split(',').map((param: string) => {
            const trimmed = param.trim();
            const paramMatch = trimmed.match(/^(\w+)\s*:/);
            return paramMatch ? paramMatch[1] : trimmed;
          }).join(', ');
          return '(' + cleanedParams + ')';
        });
        
        // Remove property type annotations (class properties only)
        // Match: whitespace + propName + : + type + = or ;
        // Replace with: whitespace + propName (preserve the = or ; that follows)
        // Handle properties with = assignment: "prop: Type = value" -> "prop = value"
        // The lookahead (?=\s*=) ensures we don't consume the =, so we just remove ": Type"
        processedLine = processedLine.replace(/^(\s+)(\w+)\s*:\s*[^=;]+(?=\s*=)/gm, '$1$2');
        // Handle properties with ; termination: "prop: Type;" -> "prop;"
        processedLine = processedLine.replace(/^(\s+)(\w+)\s*:\s*[^=;]+(?=\s*;)/gm, '$1$2');
        
        // Remove return type annotations
        processedLine = processedLine.replace(/\)\s*:\s*\w+\s*\{/g, ') {');
        
        // Remove 'as' type assertions
        processedLine = processedLine.replace(/\s+as\s+[A-Z][a-zA-Z0-9_\[\]\s\|]*/g, '');
        
        // Remove private keyword
        processedLine = processedLine.replace(/private\s+/g, '');
        
        return processedLine;
      });
      
      modifiedProcessorCode = processedLines.join('\n')
        // Remove TypeScript comment directives (safe to do on full text)
        .replace(/@ts-expect-error\s*/g, '')
        .replace(/\/\/\s*@ts-expect-error.*$/gm, '')
        .replace(/\/\/\s*@ts-ignore.*$/gm, '');
      
      // Construct the final module script
      // Use array join instead of template literal to avoid syntax errors from backticks/${} in code
      const finalWorkletScript = [
        '// --- Start of webrtcaec3.js library code ---',
        modifiedLibraryCode,
        '// --- End of webrtcaec3.js library code ---',
        '',
        '// --- Start of aec-processor.js code ---',
        modifiedProcessorCode,
        '// --- End of aec-processor.js code ---'
      ].join('\n');
      
      // Create a Blob URL from the combined script
      // AudioWorklets loaded via addModule() are treated as ES modules
      // ES modules support top-level await, so the library code can use await
      const blob = new Blob([finalWorkletScript], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      
      // Verify the script doesn't have syntax errors before loading
      // This helps catch issues early
      try {
        // Just check if it can be parsed (don't execute)
        new Function(finalWorkletScript);
      } catch (parseError: any) {
        console.warn('⚠️ Script parse check failed (might be false positive for modules):', parseError.message);
        // Don't throw - modules might have syntax that Function() can't parse
      }
      console.log('✅ AEC worklet module constructed, blob URL created');
      
      // Load the worklet module from the Blob URL
      try {
        await this.recordingContext.audioWorklet.addModule(blobUrl);
        console.log('✅ AEC processor loaded from blob URL');
        // Clean up the blob URL after loading
        URL.revokeObjectURL(blobUrl);
      } catch (e: any) {
        URL.revokeObjectURL(blobUrl); // Clean up on error too
        console.error('Failed to load AEC worklet module:', e);
        console.error('Error details:', {
          message: e?.message,
          stack: e?.stack,
          name: e?.name
        });
        // Log snippets of the script to help debug syntax errors
        const scriptPreview = finalWorkletScript.substring(0, 1000);
        console.error('Script preview (first 1000 chars):', scriptPreview);
        // Also log where the processor code starts (might be where the error is)
        const processorStartIndex = finalWorkletScript.indexOf('// --- Start of aec-processor.js code ---');
        if (processorStartIndex >= 0) {
          const processorPreview = finalWorkletScript.substring(processorStartIndex, processorStartIndex + 1500);
          console.error('Processor code preview (first 1500 chars):', processorPreview);
          // Try to find the declare statement if it still exists
          const declareIndex = finalWorkletScript.indexOf('declare const WebRtcAec3');
          if (declareIndex >= 0) {
            const declarePreview = finalWorkletScript.substring(declareIndex, declareIndex + 200);
            console.error('⚠️ Found remaining declare statement at index', declareIndex, ':', declarePreview);
          }
          // Check if async keyword is present
          const asyncIndex = finalWorkletScript.indexOf('async (ev) =>');
          const asyncWithTypeIndex = finalWorkletScript.indexOf('async (ev:');
          console.error('Async function check:', {
            'async (ev) =>': asyncIndex >= 0 ? 'Found' : 'Not found',
            'async (ev:': asyncWithTypeIndex >= 0 ? 'Found (type not removed!)' : 'Not found',
            asyncIndex,
            asyncWithTypeIndex
          });
          // Check for await usage
          const awaitIndex = finalWorkletScript.indexOf('await WebRtcAec3');
          if (awaitIndex >= 0) {
            const awaitContext = finalWorkletScript.substring(Math.max(0, awaitIndex - 100), awaitIndex + 100);
            console.error('Await context:', awaitContext);
          }
        }
        throw e;
      }
      
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
      // Pass WASM buffer so library doesn't need to fetch it
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

      // Send init message to AEC worklet with WASM buffer
      // WebRtcAec3 is already in scope from the combined module
      // Pass WASM buffer so library doesn't need to fetch it (may need API adjustment)
      this.aecNode.port.postMessage({
        type: 'init',
        sampleRate: this.recordingContext.sampleRate,
        wasm: wasmBuffer // Pass WASM buffer (may need to check if library supports this)
      }, [wasmBuffer]); // Transfer the buffer

      // Wait for AEC initialization
      await aecInitPromise;

      // Create TTS destination node in recording context (48kHz) to capture TTS audio for AEC
      // TTS audio will be resampled from 16kHz to 48kHz before being added to the audio graph
      this.ttsDestinationNode = this.recordingContext.createMediaStreamDestination();
      this.ttsSourceNode = this.recordingContext.createMediaStreamSource(this.ttsDestinationNode.stream);
      console.log('✅ TTS destination and source nodes created in recording context (48kHz)');

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
          
              // CRITICAL: Ensure recording context stays active during TTS
              // Suspended contexts cause random crackling
              if (this.recordingContext) {
                if (this.recordingContext.state === 'suspended') {
                  console.warn('⚠️ AudioContext suspended during playback - resuming to prevent crackling');
                  this.recordingContext.resume().catch(err => console.error('Failed to resume AudioContext:', err));
                }
                // Keep context alive by ensuring it's running
                if (this.recordingContext.state === 'running') {
                  // Context is active - good
                } else {
                  // Try to resume if not running
                  this.recordingContext.resume().catch(() => {});
                }
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
    
    // Cooldown check: prevent false triggers immediately after speech end
    // BUT: Skip cooldown during interrupts OR if we're already in USER_SPEAKING state (allows immediate re-trigger)
    const now = performance.now();
    const timeSinceLastSpeechEnd = now - this.lastSpeechEndTime;
    const isInterrupt = this.isPlayingTTS;
    
    // Skip cooldown if:
    // 1. This is an interrupt (user speaking during TTS) - allows immediate barge-in
    // 2. Very recent speech end (< 100ms) - allows rapid re-triggers for second interrupt
    // 3. Cooldown was reset (lastSpeechEndTime === 0) - allows immediate second interrupt
    // This ensures that when TTS starts again after first interrupt, second interrupt works immediately
    const cooldownWasReset = this.lastSpeechEndTime === 0;
    const skipCooldown = isInterrupt || (timeSinceLastSpeechEnd < 100) || cooldownWasReset;
    
    if (!skipCooldown && timeSinceLastSpeechEnd < this.SPEECH_COOLDOWN_MS) {
      console.log(`⏸️ Ignoring speech start - cooldown active (${timeSinceLastSpeechEnd.toFixed(0)}ms < ${this.SPEECH_COOLDOWN_MS}ms), isInterrupt: ${isInterrupt}, cooldownWasReset: ${cooldownWasReset}`);
      return;
    }
    
    this.vadSpeaking = true;
    const timestamp = performance.now();
    console.log(`🎤 Echo-aware VAD: SPEECH DETECTED at ${timestamp.toFixed(0)}ms`);
    
    // Handle interrupt FIRST (before initializing utterance buffer)
    if (isInterrupt) {
      console.log('🎤 Interrupt detected - stopping TTS playback');
      
      // Stop TTS playback immediately
      this.stopPlayback();
      
      // CRITICAL: Don't reduce ring buffer during interrupt - keep full buffer for better STT
      // The AEC should handle echo cancellation, so we can keep more audio for STT accuracy
      // Keep full buffer to ensure we capture the user's speech
      console.log(`🔄 Keeping full ring buffer during interrupt (${this.ringBuffer.length} chunks) for better STT accuracy`);
      
      // CRITICAL: Notify AEC that TTS has stopped so it can adapt
      // This prevents AEC from canceling user speech thinking it's echo
      if (this.aecNode) {
        this.aecNode.port.postMessage({
          type: 'tts_stopped'
        });
        console.log('🔔 Notified AEC that TTS stopped - allowing adaptation');
      }
      
      // Reset cooldown to allow immediate second interrupt
      // Set to 0 so timeSinceLastSpeechEnd will be large (now - 0 = now), bypassing cooldown
      this.lastSpeechEndTime = 0;
      
      // Send explicit interrupt command to backend
      if (this.onInterrupt) {
        console.log('⚡ Sending interrupt command to backend');
        this.onInterrupt();
      }
    }
    
    // Initialize utterance buffer WITH ring buffer (captures first word!)
    // During interrupt, this will use the reduced ring buffer (recent clean audio only)
    this.utteranceBuffer = [...this.ringBuffer];
    this.isSendingAudio = true;
    console.log(`🎤 Speech started - initialized with ${this.ringBuffer.length} ring buffer chunks (pre-roll), isSendingAudio: ${this.isSendingAudio}`);
    
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
   * Concatenate pending buffers into a single seamless buffer
   * CRITICAL: Apply crossfade at boundaries to prevent crackling
   */
  private concatenateAndScheduleBuffers(): void {
    if (!this.recordingContext || !this.pendingBuffers || this.pendingBuffers.length === 0) {
      return;
    }
    
    // If only one buffer, no need to concatenate
    if (this.pendingBuffers.length === 1) {
      this.audioQueue.push(this.pendingBuffers[0]);
      this.pendingBuffers = [];
      if (!this.isPlaying && !this.queueManagerTimer) {
        console.log('🎵 Starting smart playback queue manager');
        this.isPlaying = true;
        this.startSmartQueueManager();
      }
      return;
    }
    
    // Calculate total length
    const totalLength = this.pendingBuffers.reduce((sum, buf) => sum + buf.length, 0);
    if (totalLength === 0) {
      this.pendingBuffers = [];
      return;
    }
    
    // Create concatenated buffer
    const concatenatedBuffer = this.recordingContext.createBuffer(
      1, 
      totalLength, 
      this.recordingContext.sampleRate
    );
    const concatenatedChannel = concatenatedBuffer.getChannelData(0);
    
    // Copy buffers with crossfade at boundaries to prevent crackling
    let offset = 0;
    const crossfadeSamples = Math.floor(0.001 * this.recordingContext.sampleRate); // 1ms crossfade
    
    for (let i = 0; i < this.pendingBuffers.length; i++) {
      const buffer = this.pendingBuffers[i];
      const channelData = buffer.getChannelData(0);
      
      if (i === 0) {
        // First buffer - copy all
        concatenatedChannel.set(channelData, offset);
        offset += channelData.length;
      } else {
        // Subsequent buffers - crossfade with previous
        const prevBuffer = this.pendingBuffers[i - 1];
        const prevChannelData = prevBuffer.getChannelData(0);
        const prevEnd = offset - prevChannelData.length;
        
        // Crossfade: fade out previous, fade in current
        const fadeLength = Math.min(crossfadeSamples, Math.min(prevChannelData.length, channelData.length));
        const fadeStart = prevEnd + prevChannelData.length - fadeLength;
        
        for (let j = 0; j < fadeLength; j++) {
          const fadeProgress = j / fadeLength;
          const prevIdx = prevChannelData.length - fadeLength + j;
          const currIdx = j;
          
          // Blend: previous fades out, current fades in
          concatenatedChannel[fadeStart + j] = 
            concatenatedChannel[fadeStart + j] * (1 - fadeProgress) + 
            channelData[currIdx] * fadeProgress;
        }
        
        // Copy remaining samples from current buffer
        if (channelData.length > fadeLength) {
          concatenatedChannel.set(
            channelData.subarray(fadeLength), 
            offset
          );
          offset += channelData.length - fadeLength;
        }
      }
    }
    
    console.log(`🔗 Concatenated ${this.pendingBuffers.length} buffers with crossfades → ${concatenatedBuffer.duration.toFixed(3)}s seamless buffer`);
    
    // Clear pending buffers
    this.pendingBuffers = [];
    
    // Add concatenated buffer to queue
    this.audioQueue.push(concatenatedBuffer);
    
    // Start smart queue manager if not already running
    if (!this.isPlaying && !this.queueManagerTimer) {
      console.log('🎵 Starting smart playback queue manager');
      this.isPlaying = true;
      this.startSmartQueueManager();
    } else {
      console.log(`⏳ Buffer queued (${this.audioQueue.length} in master queue, ${this.scheduledBuffers.length} scheduled)`);
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
    
    // CRITICAL: Notify AEC that TTS stopped BEFORE stopping playback
    // This allows AEC to adapt immediately and stop canceling user speech
    if (this.aecNode) {
      this.aecNode.port.postMessage({
        type: 'tts_stopped'
      });
      console.log('🔔 Notified AEC that TTS stopped (from stopPlayback) - allowing adaptation');
    }
    
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
    
    // Connect to destination but with zero gain (silent)
    const gainNode = this.recordingContext.createGain();
    gainNode.gain.value = 0; // Silent
    this.keepAliveSource.connect(gainNode);
    gainNode.connect(this.recordingContext.destination);
    
    // Start and loop
    this.keepAliveSource.loop = true;
    this.keepAliveSource.start(0);
    
    console.log('🔇 Started keep-alive tone to prevent AudioContext suspension');
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
    this.stopKeepAliveTone();
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


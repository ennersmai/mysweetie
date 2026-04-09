/**
 * AEC (Acoustic Echo Canceller) AudioWorkletProcessor
 * 
 * Real-time echo cancellation using webrtcaec3.js library.
 * Processes microphone input against TTS playback to produce echo-free audio.
 * 
 * NOTE: This file is loaded as raw text and combined with the library code
 * into a single module via Blob URL. Do NOT use import/export statements here.
 * WebRtcAec3 will be available in scope when this code executes.
 */

// Declare WebRtcAec3 as a global for TypeScript (will be available at runtime from library code)
declare const WebRtcAec3: (options?: { wasmBinary?: ArrayBuffer }) => Promise<{
  AEC3: new (sampleRate: number, outputChannels: number, inputChannels: number) => {
    analyze(input: Float32Array[]): void;
    process(output: Float32Array[], input: Float32Array[]): void;
    processSize(input: Float32Array[]): number;
  };
}>;

// AudioWorkletProcessor and registerProcessor are globals in AudioWorklet context
// In IIFE format, access them via globalThis (available in all JavaScript contexts)
// Note: TypeScript syntax removed for Blob execution - use plain JavaScript
// @ts-ignore - AudioWorkletProcessor is available at runtime in AudioWorklet context
const AudioWorkletProcessorClass = globalThis.AudioWorkletProcessor;
// @ts-ignore - registerProcessor is available at runtime in AudioWorklet context
const registerProcessorFn = globalThis.registerProcessor;

// @ts-ignore - AudioWorkletProcessorClass is available at runtime
class AECProcessor extends AudioWorkletProcessorClass {
  // Note: TypeScript type annotations removed for Blob execution, but types kept for TS checking
  aec: any = null;
  outBuf: Float32Array[] | null = null; // Pre-allocated buffer for clean output
  sampleRate: number = 48000; // Default sample rate
  aecFrameSize: number = 0; // Required frame size for AEC processing
  micBuffer: Float32Array = new Float32Array(0); // Accumulated mic input buffer
  ttsBuffer: Float32Array = new Float32Array(0); // Accumulated TTS input buffer
  aecReady: boolean = false; // Track if AEC has processed at least one frame (ready for continuous processing)
  ttsActive: boolean = false; // Track if TTS is currently playing (for adaptive processing)
  
  constructor() {
    super();
    
    // Message handler for initialization and control messages
    this.port.onmessage = async (ev: MessageEvent) => {
      if (ev.data.type === 'tts_stopped') {
        // TTS has stopped - clear TTS buffer and mark as inactive
        // This allows AEC to adapt and stop canceling user speech
        // CRITICAL: Also clear mic buffer to prevent processing residual frames with empty TTS
        // This ensures clean passthrough of user speech immediately
        this.ttsBuffer = new Float32Array(0);
        this.micBuffer = new Float32Array(0); // Clear mic buffer to force passthrough
        this.ttsActive = false;
        console.log('🔔 AEC: TTS stopped - cleared TTS and mic buffers, marked inactive (forcing passthrough)');
        return;
      }
      
      if (ev.data.type === 'init') {
        try {
          const { sampleRate, wasm } = ev.data;
          this.sampleRate = sampleRate || 48000;
          
          // WebRtcAec3 is now in scope (from the combined module script)
          // No need to load or execute library code - it's already available
          if (typeof WebRtcAec3 === 'undefined') {
            throw new Error('WebRtcAec3 not found in scope - library code may not have loaded correctly');
          }
          
          // Step 1: Call the async factory function with the pre-fetched WASM buffer
          // This prevents network requests from within the Blob worklet
          // The factory accepts wasmBinary parameter to provide the WASM buffer directly
          const AEC3Module = await WebRtcAec3({ wasmBinary: wasm });
          
          // Step 4: Use the constructor from the module to create the instance
          // API: new AEC3(sampleRate, outputChannels, inputChannels)
          // outputChannels = 1 (TTS/render), inputChannels = 1 (mic/capture)
          this.aec = new AEC3Module.AEC3(this.sampleRate, 1, 1);
          
          // Step 5: Determine the required frame size for AEC processing
          // WebRTC AEC3 typically processes in 10ms frames
          // At 48kHz: 480 samples = 10ms
          // Try to get the frame size from the library, but fallback to 480 if it returns 0
          const tempInput = [new Float32Array(480)]; // Try with 10ms frame (480 samples at 48kHz)
          this.aecFrameSize = this.aec.processSize(tempInput);
          
          // If processSize returns 0 or invalid, use standard 10ms frame size
          if (this.aecFrameSize === 0 || this.aecFrameSize < 128) {
            console.warn(`⚠️ AEC processSize returned ${this.aecFrameSize}, using default 480 samples (10ms at 48kHz)`);
            this.aecFrameSize = 480; // Standard 10ms frame at 48kHz
          }
          
          this.outBuf = [new Float32Array(this.aecFrameSize)] as Float32Array[]; // Library expects array of Float32Arrays
          
          console.log(`✅ AEC initialized at ${this.sampleRate}Hz (1 render, 1 capture channel), frame size: ${this.aecFrameSize}`);
          
          if (this.aecFrameSize > 128) {
            console.log(`ℹ️ AEC requires ${this.aecFrameSize} samples per frame (larger than standard 128-sample worklet frames)`);
          }
          
          // Notify main thread that initialization is complete
          this.port.postMessage({ type: 'init-done' });
        } catch (error) {
          console.error('❌ Failed to initialize AEC:', error);
          const errorMessage = error && typeof error === 'object' && 'message' in error 
            ? error.message 
            : String(error);
          this.port.postMessage({ 
            type: 'init-error', 
            error: errorMessage
          });
        }
      }
    };
  }
  
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // Guard: If AEC is not initialized or output buffer not ready, output silence
    if (!this.aec || !this.outBuf || this.aecFrameSize === 0) {
      const output = outputs[0];
      if (output && output[0]) {
        output[0].fill(0); // Fill with silence
      }
      return true; // Keep processor alive
    }
    
    // Get inputs: mic on input 0, TTS on input 1
    const micInput = inputs[0];
    const ttsInput = inputs[1];
    const cleanOutput = outputs[0];
    
    // Check if we have valid inputs and output
    if (!micInput || !micInput[0] || !cleanOutput || !cleanOutput[0]) {
      return true; // Keep processor alive
    }
    
    const frameSize = micInput[0].length; // Standard worklet frame size (128 samples)
    
    
    // Accumulate mic input into buffer
    // Optimization: avoid constant reallocations by using fixed buffers or more efficient growth
    // For 128 -> 480 samples, we only need a small overhead
    const growBuffer = (oldBuf: Float32Array, newData: Float32Array) => {
      const combined = new Float32Array(oldBuf.length + newData.length);
      combined.set(oldBuf);
      combined.set(newData, oldBuf.length);
      return combined;
    };

    this.micBuffer = growBuffer(this.micBuffer, micInput[0]);
    
    // Accumulate TTS input (AEC reference)
    if (ttsInput && ttsInput[0] && ttsInput[0].length > 0) {
      this.ttsActive = true;
      this.ttsBuffer = growBuffer(this.ttsBuffer, ttsInput[0]);
    } else if (this.ttsActive) {
      this.ttsBuffer = new Float32Array(0);
      this.ttsActive = false;
    } else {
      // Pad TTS with zeros if not active but we have mic data (to maintain alignment)
      this.ttsBuffer = growBuffer(this.ttsBuffer, new Float32Array(micInput[0].length));
    }

    
    // Process accumulated frames when we have enough data
    const cleanOutputChannel = cleanOutput[0];
    let outputOffset = 0;
    let processedAnyFrames = false;
    
    // Process as many 480-sample frames as we can
    while (this.micBuffer.length >= this.aecFrameSize && outputOffset < frameSize) {
      processedAnyFrames = true;
      try {
        // Extract frame-sized chunks from buffers
        const micFrame = this.micBuffer.subarray(0, this.aecFrameSize);
        const ttsFrame = this.ttsBuffer.subarray(0, this.aecFrameSize);
        
        // Prepare inputs in the format AEC expects (array of Float32Arrays)
        const micChannels = [micFrame];
        const ttsChannels = [ttsFrame];
        
        // Step 1: Analyze the playback/render stream (TTS) - only if TTS is active
        // If TTS has stopped, don't analyze (prevents AEC from canceling user speech)
        if (this.ttsActive || this.ttsBuffer.length > 0) {
          // TTS is active or we have residual TTS data - analyze it
          // API: aec.analyze(ttsInput) where ttsInput is Float32Array[]
          this.aec.analyze(ttsChannels);
        }
        // If TTS has stopped and buffer is cleared, skip analyze to allow user speech through
        
        // Step 2: Process the capture stream (Mic), writing to our pre-allocated buffer
        // API: aec.process(outBuf, micInput) where both are Float32Array[]
        // This modifies outBuf in place
        this.aec.process(this.outBuf, micChannels);
        
        // Step 3: Copy the result from our pre-allocated buffer to the worklet output
        const processedChannel = this.outBuf[0];
        const remainingOutputSpace = frameSize - outputOffset;
        const copyLength = Math.min(processedChannel.length, remainingOutputSpace);
        
        cleanOutputChannel.set(processedChannel.subarray(0, copyLength), outputOffset);
        outputOffset += copyLength;
        
        // Remove processed samples from buffers
        this.micBuffer = this.micBuffer.subarray(this.aecFrameSize);
        this.ttsBuffer = this.ttsBuffer.subarray(this.aecFrameSize);
      } catch (error) {
        // On error, output silence and clear buffers
        console.error('AEC processing error:', error);
        cleanOutputChannel.fill(0, outputOffset);
        this.micBuffer = new Float32Array(0);
        this.ttsBuffer = new Float32Array(0);
        return true;
      }
    }
    
    // If we didn't process any frames (not enough accumulated data)
    if (!processedAnyFrames) {
      // CRITICAL: Use passthrough during initial accumulation so VAD can detect speech
      // BUT: If TTS just stopped, use processed output (even if empty) to allow AEC adaptation
      // Once AEC is ready (has processed at least one frame), it will process continuously
      if (!this.aecReady) {
        // Initial accumulation: use passthrough so VAD can detect speech
        // This is necessary because VAD needs audio to work, even if it has some echo
        cleanOutputChannel.set(micInput[0]);
      } else if (!this.ttsActive && this.ttsBuffer.length === 0) {
        // TTS has stopped and buffer is cleared - AEC should pass through user speech
        // Use passthrough to ensure user speech gets through immediately
        cleanOutputChannel.set(micInput[0]);
      } else {
        // AEC was ready but temporarily doesn't have enough data
        // Use passthrough to maintain audio flow
        cleanOutputChannel.set(micInput[0]);
      }
    } else {
      // Mark AEC as ready once we've processed at least one frame
      this.aecReady = true;
      
      if (outputOffset < frameSize) {
        // We processed some frames but didn't fill the entire output buffer
        // Fill the remainder with passthrough to maintain audio flow
        const remainingSamples = frameSize - outputOffset;
        cleanOutputChannel.set(micInput[0].subarray(0, remainingSamples), outputOffset);
      }
    }
    
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor so it can be instantiated
// @ts-ignore - TypeScript doesn't understand AudioWorklet runtime types
registerProcessorFn('aec-processor', AECProcessor);


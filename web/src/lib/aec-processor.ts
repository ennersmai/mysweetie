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
// @ts-expect-error - These are runtime globals provided by the browser
const AudioWorkletProcessorClass = globalThis.AudioWorkletProcessor;
// @ts-expect-error - These are runtime globals provided by the browser
const registerProcessorFn = globalThis.registerProcessor;

class AECProcessor extends AudioWorkletProcessorClass {
  // Note: TypeScript type annotations removed for Blob execution, but types kept for TS checking
  aec: any = null;
  outBuf: Float32Array[] | null = null; // Pre-allocated buffer for clean output
  sampleRate: number = 48000; // Default sample rate
  
  constructor() {
    super();
    
    // Message handler for initialization
    this.port.onmessage = async (ev: MessageEvent) => {
      if (ev.data.type === 'init') {
        try {
          const { sampleRate, wasm } = ev.data;
          this.sampleRate = sampleRate || 48000;
          
          // WebRtcAec3 is now in scope (from the combined module script)
          // No need to load or execute library code - it's already available
          // @ts-expect-error - WebRtcAec3 is available from the library code in the same module
          if (typeof WebRtcAec3 === 'undefined') {
            throw new Error('WebRtcAec3 not found in scope - library code may not have loaded correctly');
          }
          
          // Step 1: Call the async factory function with the pre-fetched WASM buffer
          // This prevents network requests from within the Blob worklet
          // The factory accepts wasmBinary parameter to provide the WASM buffer directly
          // @ts-expect-error - WebRtcAec3 is available from the library code in the same module
          const AEC3Module = await WebRtcAec3({ wasmBinary: wasm });
          
          // Step 4: Use the constructor from the module to create the instance
          // API: new AEC3(sampleRate, outputChannels, inputChannels)
          // outputChannels = 1 (TTS/render), inputChannels = 1 (mic/capture)
          this.aec = new AEC3Module.AEC3(this.sampleRate, 1, 1);
          
          // Step 5: Pre-allocate output buffer according to library's required size
          // API: const bufSz = aec.processSize(inputData)
          // A standard worklet frame is 128 samples
          const tempInput = [new Float32Array(128)]; // Dummy input to get the size
          const bufSz = this.aec.processSize(tempInput);
          this.outBuf = [new Float32Array(bufSz)] as Float32Array[]; // Library expects array of Float32Arrays
          
          console.log(`✅ AEC initialized at ${this.sampleRate}Hz (1 render, 1 capture channel), buffer size: ${bufSz}`);
          
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
    if (!this.aec || !this.outBuf) {
      const output = outputs[0];
      if (output && output[0]) {
        output[0].fill(0); // Fill with silence
      }
      return true; // Keep processor alive
    }
    
    // Get inputs: mic on input 0, TTS on input 1
    // API expects arrays of Float32Arrays (array of channels)
    const micInput = inputs[0];
    const ttsInput = inputs[1];
    const cleanOutput = outputs[0];
    
    // Check if we have valid inputs and output
    if (!micInput || !micInput[0] || !cleanOutput || !cleanOutput[0]) {
      return true; // Keep processor alive
    }
    
    // API expects arrays of Float32Arrays
    const micChannels = micInput; // Already in correct format
    const ttsChannels = ttsInput || [new Float32Array(0)]; // Provide empty array if no TTS
    
    try {
      // Step 1: Analyze the playback/render stream (TTS)
      // API: aec.analyze(ttsInput) where ttsInput is Float32Array[]
      if (ttsChannels[0] && ttsChannels[0].length > 0) {
        this.aec.analyze(ttsChannels);
      }
      
      // Step 2: Process the capture stream (Mic), writing to our pre-allocated buffer
      // API: aec.process(outBuf, micInput) where both are Float32Array[]
      // This modifies outBuf in place
      this.aec.process(this.outBuf, micChannels);
      
      // Step 3: Copy the result from our pre-allocated buffer to the worklet output
      const cleanOutputChannel = cleanOutput[0];
      const processedChannel = this.outBuf[0];
      
      if (processedChannel && processedChannel.length > 0) {
        // Copy what we can (may be different size due to AEC processing)
        const copyLength = Math.min(processedChannel.length, cleanOutputChannel.length);
        cleanOutputChannel.set(processedChannel.subarray(0, copyLength));
        // Fill remainder with silence if needed
        if (copyLength < cleanOutputChannel.length) {
          cleanOutputChannel.fill(0, copyLength);
        }
      } else {
        // Fallback: output silence if processing failed
        cleanOutputChannel.fill(0);
      }
    } catch (error) {
      // On error, output silence to prevent audio artifacts
      console.error('AEC processing error:', error);
      if (cleanOutput && cleanOutput[0]) {
        cleanOutput[0].fill(0);
      }
    }
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor so it can be instantiated
registerProcessorFn('aec-processor', AECProcessor);


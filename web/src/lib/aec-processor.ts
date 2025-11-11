/**
 * AEC (Acoustic Echo Canceller) AudioWorkletProcessor
 * 
 * Real-time echo cancellation using webrtcaec3.js library.
 * Processes microphone input against TTS playback to produce echo-free audio.
 * 
 * Note: AudioWorkletProcessor and registerProcessor are global APIs provided
 * by the browser in the AudioWorklet context. They are declared in audio-worklet.d.ts
 * for TypeScript type checking, but are available at runtime as globals.
 */

// AudioWorkletProcessor and registerProcessor are globals in AudioWorklet context
// In IIFE format, access them via globalThis (available in all JavaScript contexts)
// Do NOT reference 'self' directly as it may not be defined in IIFE format
// @ts-ignore - These are runtime globals provided by the browser
const AudioWorkletProcessorClass = (globalThis as any).AudioWorkletProcessor;
// @ts-ignore
const registerProcessorFn = (globalThis as any).registerProcessor;

// AudioWorklets don't support importScripts, so we'll execute code using Function constructor

class AECProcessor extends AudioWorkletProcessorClass {
  private aec: any = null;
  private outBuf: Float32Array[] | null = null; // Pre-allocated buffer for clean output
  private sampleRate: number = 48000; // Default sample rate
  
  constructor() {
    super();
    
    // Message handler for initialization
    this.port.onmessage = async (ev: MessageEvent) => {
      if (ev.data.type === 'init') {
        try {
          const { sampleRate, jsCode } = ev.data;
          this.sampleRate = sampleRate || 48000;
          
          // Step 1: Execute the library code using Function constructor
          // AudioWorklets don't support importScripts, so we execute the code directly
          // The library code will be executed in this context and create globals
          console.log('Executing webrtcaec3 JS library code, length:', jsCode?.length || 0);
          
          // Create a function that executes the library code
          // This will make WebRtcAec3 available as a global
          // @ts-ignore - Function constructor is available
          const executeLibrary = new Function(jsCode);
          executeLibrary();
          
          // Step 2: Get the WebRtcAec3 factory function (now available as global)
          // The library should be available as a global after execution
          // @ts-ignore - WebRtcAec3 is a global after executing the library code
          const WebRtcAec3 = (globalThis as any).WebRtcAec3;
          
          if (!WebRtcAec3) {
            throw new Error('WebRtcAec3 not found after executing library code');
          }
          
          // Step 3: Call the async factory function to get the module
          // API: await WebRtcAec3() - takes no parameters, fetches WASM itself
          // The library will fetch its WASM file from the wasmUrl we provide
          // We need to set up the environment so the library can find the WASM
          // The library might look for WASM relative to the current location
          // Set location.href or use a similar mechanism if needed
          const AEC3Module = await WebRtcAec3();
          
          // Step 4: Use the constructor from the module to create the instance
          // API: new AEC3(sampleRate, outputChannels, inputChannels)
          // outputChannels = 1 (TTS/render), inputChannels = 1 (mic/capture)
          this.aec = new AEC3Module.AEC3(this.sampleRate, 1, 1);
          
          // Step 5: Pre-allocate output buffer according to library's required size
          // API: const bufSz = aec.processSize(inputData)
          // A standard worklet frame is 128 samples
          const tempInput = [new Float32Array(128)]; // Dummy input to get the size
          const bufSz = this.aec.processSize(tempInput);
          this.outBuf = [new Float32Array(bufSz)]; // Library expects array of Float32Arrays
          
          console.log(`✅ AEC initialized at ${this.sampleRate}Hz (1 render, 1 capture channel), buffer size: ${bufSz}`);
          
          // Notify main thread that initialization is complete
          this.port.postMessage({ type: 'init-done' });
        } catch (error: any) {
          console.error('❌ Failed to initialize AEC:', error);
          this.port.postMessage({ 
            type: 'init-error', 
            error: error.message || String(error)
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


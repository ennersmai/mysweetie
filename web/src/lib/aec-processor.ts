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
// Access them via 'self' which is available in AudioWorklet execution context
// @ts-ignore - These are runtime globals provided by the browser
const AudioWorkletProcessorClass = (self as any).AudioWorkletProcessor;
const registerProcessorFn = (self as any).registerProcessor;

class AECProcessor extends AudioWorkletProcessorClass {
  private aec: any = null;
  private aecModule: any = null; // The WebRtcAec3 module instance
  private sampleRate: number = 48000; // Default sample rate
  private renderNumChannels: number = 1; // Mono render/output (TTS) - what's being played
  private captureNumChannels: number = 1; // Mono capture/input (mic) - what's being recorded
  
  constructor() {
    super();
    
    // Message handler for initialization
    this.port.onmessage = async (ev: MessageEvent) => {
      if (ev.data.type === 'init') {
        try {
          this.sampleRate = ev.data.sampleRate || 48000;
          
          // Step 1: Dynamically import the library from public directory
          // Loading from public URL prevents Vite from bundling it and breaking WASM loading code
          // The library expects to load WASM from /webrtcaec3-0.3.0.wasm (from public directory)
          // @vite-ignore tells Vite to treat this as a runtime URL, not a bundled module
          // Using a variable prevents TypeScript from resolving it as a module path at compile time
          const libPath: string = '/webrtcaec3-0.3.0.js';
          const mod = await import(/* @vite-ignore */ libPath);
          
          // Temporary: Log mod shape for debugging export structure
          console.log('webrtcaec3 module shape:', Object.keys(mod), 'default:', !!mod.default, 'WebRtcAec3:', !!(mod as any).WebRtcAec3);
          
          const WebRtcAec3 = (mod as any).default ?? (mod as any).WebRtcAec3;
          
          // Step 2: Get the WebRtcAec3 module instance
          // WebRtcAec3() is a function that returns a promise for the module
          // The library will automatically find the WASM file if it's accessible
          // WASM should be at /webrtcaec3-0.3.0.wasm (from public directory)
          this.aecModule = await WebRtcAec3();
          
          // Step 2: Create AEC3 instance with constructor
          // Constructor: (sampleRate, renderNumChannels, captureNumChannels)
          // renderNumChannels = number of TTS/render channels (mono = 1)
          // captureNumChannels = number of mic/capture channels (mono = 1)
          this.aec = new this.aecModule.AEC3(
            this.sampleRate,
            this.renderNumChannels,
            this.captureNumChannels
          );
          
          console.log(`✅ AEC initialized at ${this.sampleRate}Hz (${this.renderNumChannels} render, ${this.captureNumChannels} capture channels)`);
          
          // Notify main thread that initialization is complete
          this.port.postMessage({ type: 'init-done' });
        } catch (error: any) {
          console.error('❌ Failed to initialize AEC:', error);
          this.port.postMessage({ 
            type: 'init-error', 
            error: error.message 
          });
        }
      }
    };
  }
  
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // Guard: If AEC is not initialized, output silence
    if (!this.aec) {
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
    
    const micChannel = micInput[0];
    const ttsChannel = ttsInput && ttsInput[0] ? ttsInput[0] : null;
    const outputChannel = cleanOutput[0];
    
    try {
      // Analyze playback: Feed TTS audio to AEC's analyze method
      // analyze expects Float32Array[] (array of channels)
      // This tells the AEC what audio is being played so it can cancel echoes
      if (ttsChannel && ttsChannel.length > 0) {
        this.aec.analyze([ttsChannel]); // Wrap in array for channel format
      }
      
      // Process microphone: Process mic input against analyzed playback
      // process expects (outputBuffer, inputData) where:
      // - outputBuffer is Float32Array[] (array of channels) that will be modified in place
      // - inputData is Float32Array[] (array of channels)
      
      // First, get the required output buffer size
      const bufSz = this.aec.processSize([micChannel]);
      
      // Create output buffer (array of Float32Arrays, one per channel)
      const outBuf = [new Float32Array(bufSz)];
      
      // Process: this modifies outBuf in place
      this.aec.process(outBuf, [micChannel]); // Wrap both in arrays for channel format
      
      // Copy processed audio to worklet output buffer
      const processedChannel = outBuf[0];
      if (processedChannel && processedChannel.length > 0) {
        // Copy what we can (may be different size due to AEC processing)
        const copyLength = Math.min(processedChannel.length, outputChannel.length);
        outputChannel.set(processedChannel.subarray(0, copyLength));
        // Fill remainder with silence if needed
        if (copyLength < outputChannel.length) {
          outputChannel.fill(0, copyLength);
        }
      } else {
        // Fallback: output silence if processing failed
        outputChannel.fill(0);
      }
    } catch (error) {
      // On error, output silence to prevent audio artifacts
      console.error('AEC processing error:', error);
      outputChannel.fill(0);
    }
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor so it can be instantiated
registerProcessorFn('aec-processor', AECProcessor);


/**
 * AudioWorkletProcessor for low-latency audio capture
 * 
 * This processor runs in a separate high-priority thread and streams
 * raw PCM audio data to the main thread for VAD analysis and buffering.
 */

class AudioProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    
    // Check if we have valid input data
    if (input && input[0]) {
      // Send the Float32Array PCM data to main thread
      // This is a zero-copy operation (transferable)
      this.port.postMessage(input[0]);
    }
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor so it can be instantiated
registerProcessor('audio-processor', AudioProcessor);


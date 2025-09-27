/**
 * PCM Audio Processor Worklet
 * 
 * This worklet processes audio data in real-time to convert it to PCM s16le format
 * for transmission to the backend WebSocket.
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    this.sampleRate = options?.processorOptions?.sampleRate || 16000;
    this.bitDepth = options?.processorOptions?.bitDepth || 16;
    this.isRecording = false;
    
    // Buffer for accumulating samples
    this.bufferSize = 512; // Process in chunks of 512 samples
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
    
    // Listen for control messages
    this.port.onmessage = (event) => {
      if (event.data.type === 'start') {
        this.isRecording = true;
      } else if (event.data.type === 'stop') {
        this.isRecording = false;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    
    if (!this.isRecording || !input || input.length === 0) {
      return true;
    }

    const inputChannel = input[0]; // Use first channel (mono)
    
    for (let i = 0; i < inputChannel.length; i++) {
      this.buffer[this.bufferIndex] = inputChannel[i];
      this.bufferIndex++;
      
      // When buffer is full, convert to PCM and send
      if (this.bufferIndex >= this.bufferSize) {
        this.sendPCMBuffer();
        this.bufferIndex = 0;
      }
    }

    return true;
  }

  sendPCMBuffer() {
    // Convert float32 samples to int16 PCM
    const pcmBuffer = new Int16Array(this.bufferSize);
    
    for (let i = 0; i < this.bufferSize; i++) {
      // Clamp to [-1, 1] and convert to 16-bit signed integer
      const sample = Math.max(-1, Math.min(1, this.buffer[i] || 0));
      pcmBuffer[i] = Math.round(sample * 32767);
    }

    // Send the PCM data as ArrayBuffer
    this.port.postMessage({
      type: 'pcm-data',
      buffer: pcmBuffer.buffer,
      sampleRate: this.sampleRate
    });
  }
}

registerProcessor('pcm-processor', PCMProcessor);

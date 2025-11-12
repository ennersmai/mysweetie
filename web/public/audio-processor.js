/**
 * Simple VAD AudioWorkletProcessor
 * 
 * Basic voice activity detection on microphone input.
 * Pass-through audio processing for clean foundation.
 */

class AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    // Simple VAD state machine
    this.vadSpeaking = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    
    // Simple VAD parameters
    this.VAD_THRESHOLD = 0.0045;
    this.SPEECH_FRAMES_REQUIRED = 4;
    this.SILENCE_FRAMES_REQUIRED = 30;
    
    // Message handler for threshold updates
    this.port.onmessage = (event) => {
      if (event.data.type === 'vad_threshold') {
        this.VAD_THRESHOLD = event.data.threshold || 0.0045;
      }
    };
  }
  
  /**
   * Calculate RMS (Root Mean Square) energy of audio channel
   */
  calculateRMS(channel) {
    if (!channel || channel.length === 0) return 0;
    
    let sum = 0;
    for (let i = 0; i < channel.length; i++) {
      sum += channel[i] * channel[i];
    }
    return Math.sqrt(sum / channel.length);
  }
  
  process(inputs, outputs) {
    const micInput = inputs[0];
    
    // Check if we have valid microphone input
    if (!micInput || !micInput[0]) {
      return true; // Keep processor alive
    }
    
    const micChannel = micInput[0];
    
    // Pass-through: copy input to output
    if (outputs[0] && outputs[0][0]) {
      outputs[0][0].set(micChannel);
    }
    
    // Calculate RMS for VAD
    const rmsMic = this.calculateRMS(micChannel);
    const isSpeechFrame = rmsMic > this.VAD_THRESHOLD;
    
    // Debug logging (log every 100 frames to avoid spam)
    if (!this.frameCount) this.frameCount = 0;
    this.frameCount++;
    if (this.frameCount % 100 === 0) {
      console.log(`[VAD] RMS: ${rmsMic.toFixed(6)}, Threshold: ${this.VAD_THRESHOLD.toFixed(6)}, isSpeech: ${isSpeechFrame}, speaking: ${this.vadSpeaking}`);
    }
    
    // Simple VAD state machine
    if (isSpeechFrame) {
      this.speechFrames++;
      this.silenceFrames = 0;
      
      // Trigger speech start if we've had enough consecutive speech frames
      if (!this.vadSpeaking && this.speechFrames >= this.SPEECH_FRAMES_REQUIRED) {
        this.vadSpeaking = true;
        this.port.postMessage({
          type: 'speech_start'
        });
      }
    } else {
      this.silenceFrames++;
      this.speechFrames = 0;
      
      // Trigger speech end if we've had enough consecutive silence frames
      if (this.vadSpeaking && this.silenceFrames >= this.SILENCE_FRAMES_REQUIRED) {
        this.vadSpeaking = false;
        this.port.postMessage({
          type: 'speech_end'
        });
      }
    }
    
    // Forward microphone audio to main thread for STT processing
    this.port.postMessage({
      type: 'audio_data',
      data: micChannel
    });
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor so it can be instantiated
registerProcessor('audio-processor', AudioProcessor);
